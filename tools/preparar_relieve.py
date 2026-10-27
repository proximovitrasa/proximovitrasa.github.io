#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only · © 2026 asergom · ver LICENSE y TERMINOS-ADICIONALES.md
"""Prepara data/relieve/mdt_vigo.tif a partir del MDT descargado del IGN (tools/descargar_relieve.py).

Solo se guarda el terreno a menos de 300 m de la red peatonal actual (el resto, sin dato), para que
el fichero sea pequeño. El terreno no cambia, así que basta con hacerlo una vez; el Action mensual
solo lo lee. Si la red crece mucho por los bordes, volver a ejecutarlo con el MDT de la rama
datos-relieve:

    git show origin/datos-relieve:fuentes/mdt_vigo.tif > /tmp/mdt.tif
    python3 tools/preparar_relieve.py /tmp/mdt.tif

Datos: © Instituto Geográfico Nacional (CC BY 4.0), MDT05 (PNOA-LiDAR).
"""
import json
import os
import struct
import sys
import zlib

import numpy as np

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(RAIZ, "tools"))
import relieve  # noqa: E402

MARGEN = 300        # metros alrededor de la red
FILAS = 16          # filas por tira


def red_puntos():
    d = json.load(open(os.path.join(RAIZ, "data/peatonal.json")))
    out, la, lo = [], 0, 0
    for i in range(0, len(d["nodos"]), 2):
        la += d["nodos"][i]
        lo += d["nodos"][i + 1]
        out.append((la / 1e5, lo / 1e5))
    for f in d["formas"]:   # puntos intermedios (polilínea de Google)
        i = lat = lng = 0
        while i < len(f):
            for k in range(2):
                b = shift = res = 0
                while True:
                    b = ord(f[i]) - 63
                    i += 1
                    res |= (b & 31) << shift
                    shift += 5
                    if b < 32:
                        break
                v = ~(res >> 1) if res & 1 else res >> 1
                if k == 0:
                    lat += v
                else:
                    lng += v
            out.append((lat / 1e5, lng / 1e5))
    return out


def escribir_tif(ruta, a, geo, nodata):
    """GeoTIFF int16, tiras deflate con predictor horizontal, EPSG:4326."""
    H, W = a.shape
    x0, sx, y0, sy = geo
    tiras = []
    for r in range(0, H, FILAS):
        t = a[r:r + FILAS].astype("<i2")
        d = np.diff(t, axis=1, prepend=np.zeros((t.shape[0], 1), "<i2")).astype("<i2")
        tiras.append(zlib.compress(d.tobytes(), 9))
    n = len(tiras)
    geokeys = [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]
    nd = (str(nodata) + "\0").encode()
    entradas = [  # (etiqueta, tipo, valores)
        (256, 4, [W]), (257, 4, [H]), (258, 3, [16]), (259, 3, [8]), (262, 3, [1]),
        (273, 4, None), (277, 3, [1]), (278, 4, [FILAS]), (279, 4, [len(t) for t in tiras]),
        (284, 3, [1]), (317, 3, [2]), (339, 3, [2]),
        (33550, 12, [sx, sy, 0.0]), (33922, 12, [0.0, 0.0, 0.0, x0, y0, 0.0]),
        (34735, 3, geokeys), (42113, 2, nd),
    ]
    fmt = {3: "H", 4: "I", 12: "d"}
    ifd = 8
    datos_off = ifd + 2 + 12 * len(entradas) + 4
    extra = bytearray()

    def bloque(tipo, vals):
        if tipo == 2:
            return bytes(vals), len(vals)
        return struct.pack("<" + fmt[tipo] * len(vals), *vals), len(vals)

    # Primero, dónde irán las tiras: después de los valores largos de la cabecera.
    largos = []
    for tag, tipo, vals in entradas:
        if vals is None:
            vals = [0] * n
        b, cnt = bloque(tipo, vals)
        largos.append(len(b) if len(b) > 4 else 0)
    inicio_tiras = datos_off + sum(x + (x & 1) for x in largos)
    offs, p = [], inicio_tiras
    for t in tiras:
        offs.append(p)
        p += len(t)
    cab = bytearray(b"II*\0" + struct.pack("<I", ifd) + struct.pack("<H", len(entradas)))
    for tag, tipo, vals in entradas:
        if vals is None:
            vals = offs
        b, cnt = bloque(tipo, vals)
        if len(b) <= 4:
            cab += struct.pack("<HHI", tag, tipo, cnt) + b.ljust(4, b"\0")
        else:
            cab += struct.pack("<HHII", tag, tipo, cnt, datos_off + len(extra))
            extra += b
            if len(extra) & 1:
                extra += b"\0"
    cab += struct.pack("<I", 0)
    with open(ruta, "wb") as f:
        f.write(bytes(cab) + bytes(extra))
        for t in tiras:
            f.write(t)


def main():
    a, geo, nd = relieve.leer_tif(sys.argv[1])
    x0, sx, y0, sy = geo
    H, W = a.shape
    cerca = np.zeros((H, W), dtype=np.int32)
    for lat, lon in red_puntos():
        c, r = int((lon - x0) / sx), int((y0 - lat) / sy)
        if 0 <= r < H and 0 <= c < W:
            cerca[r, c] = 1
    # Dilatación con una caja de ±MARGEN (imagen integral).
    rr = int(MARGEN / (sy * 110540)) + 1
    rc = int(MARGEN / (sx * 82500)) + 1
    S = np.pad(cerca, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    r0 = np.clip(np.arange(H) - rr, 0, H)
    r1 = np.clip(np.arange(H) + rr + 1, 0, H)
    c0 = np.clip(np.arange(W) - rc, 0, W)
    c1 = np.clip(np.arange(W) + rc + 1, 0, W)
    caja = S[r1][:, c1] - S[r0][:, c1] - S[r1][:, c0] + S[r0][:, c0]
    out = a.astype(np.int32)
    if nd is not None:
        out[a == nd] = -32768
    out[caja == 0] = -32768
    ok = out != -32768          # (ya en decímetros, como espera tools/relieve.py)
    os.makedirs(os.path.join(RAIZ, "data/relieve"), exist_ok=True)
    ruta = os.path.join(RAIZ, "data/relieve/mdt_vigo.tif")
    escribir_tif(ruta, out.astype(np.int16), geo, -32768)
    print(f"{ruta}: {os.path.getsize(ruta) / 1e6:.2f} MB, {ok.mean() * 100:.0f} % con dato")


if __name__ == "__main__":
    main()
