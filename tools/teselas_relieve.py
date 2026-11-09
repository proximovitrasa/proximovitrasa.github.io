# SPDX-License-Identifier: AGPL-3.0-only
"""Teselas de terreno para el relieve sombreado del mapa nuevo (tareas 41 + 47, fase 7, punto 2).

Convierte el modelo digital del terreno del IGN que ya usamos para las cuestas
(data/relieve/mdt_vigo.tif, celdas de ~5,5 m, alturas en decímetros) en teselas PNG de 256 px con
la codificación "terrarium" (altura = R·256 + G + B/256 − 32768), que MapLibre sombrea con una capa
"hillshade". El mar y lo que no tiene dato quedan a 0 m. Alturas redondeadas a 1 m (comprimen
mucho mejor y para sombrear sobra).

Uso: python3 tools/teselas_relieve.py [zoom_max]   (por defecto 13) → data/relieve/teselas/{z}/{x}/{y}.png
"""
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from relieve import leer_tif  # noqa: E402

ZMIN = 10
ZMAX = int(sys.argv[1]) if len(sys.argv) > 1 else 13
OUT = ROOT / "data/relieve/teselas"


def main():
    arr, (x0, sx, y0, sy), nd = leer_tif(str(ROOT / "data/relieve/mdt_vigo.tif"))
    if sy > 0:
        sy = -sy   # filas hacia el sur
    z = arr.astype("f4") / 10
    z[(arr == (nd if nd is not None else -32768)) | (arr <= 3)] = 0
    rows, cols = z.shape
    west, north = x0, y0
    east, south = x0 + sx * cols, y0 + sy * rows
    total = size = 0
    for zoom in range(ZMIN, ZMAX + 1):
        n = 2 ** zoom
        tx0 = int((west + 180) / 360 * n)
        tx1 = int((east + 180) / 360 * n)
        ty = lambda lat: int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
        ty0, ty1 = ty(north), ty(south)
        for tx in range(tx0, tx1 + 1):
            for tyi in range(ty0, ty1 + 1):
                # centro de cada píxel de la tesela → lat, lon → celda del MDT (vecino más cercano)
                px = (np.arange(256) + 0.5) / 256
                lon = (tx + px) / n * 360 - 180
                yy = (tyi + px) / n
                lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * yy))))
                c = np.floor((lon - x0) / sx).astype(int)
                r = np.floor((lat - y0) / sy).astype(int)
                okc = (c >= 0) & (c < cols)
                okr = (r >= 0) & (r < rows)
                tile = np.zeros((256, 256), "f4")
                tile[np.ix_(okr, okc)] = z[np.ix_(r[okr], c[okc])]
                v = np.round(tile).astype("i4") + 32768
                rgb = np.zeros((256, 256, 3), "u1")
                rgb[..., 0] = v // 256
                rgb[..., 1] = v % 256
                p = OUT / str(zoom) / str(tx) / f"{tyi}.png"
                p.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgb, "RGB").save(p, optimize=True)
                total += 1
                size += p.stat().st_size
        print(f"zoom {zoom}: hecho")
    print(f"{total} teselas, {size / 1e6:.1f} MB; límites (oeste, sur, este, norte): {west:.5f}, {south:.5f}, {east:.5f}, {north:.5f}")


if __name__ == "__main__":
    main()
