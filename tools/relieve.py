# SPDX-License-Identifier: AGPL-3.0-only · © 2026 asergom · ver LICENSE y TERMINOS-ADICIONALES.md
"""Relieve (altura del terreno) y coste de andar en cuesta.

data/relieve/mdt_vigo.tif: modelo digital del terreno del IGN (MDT05, sin edificios), reducido a una
rejilla en grados; enteros en decímetros, -32768 = sin dato (mar). Lo usa tools/actualizar_peatonal.py
para saber cuánto se sube y se baja en cada tramo de calle.
Datos: © Instituto Geográfico Nacional (CC BY 4.0), MDT05 del PNOA-LiDAR.

Coste de andar: se mide en "metros equivalentes", los que se andarían en llano a 4,5 km/h en el
mismo tiempo. Subiendo se usa la fórmula de Tobler (la velocidad baja con la pendiente:
×exp(3,5·p)); bajando, hasta el 10 % se va igual que en llano y, más empinado, más despacio.
En escaleras, igual, pero con la altura de cada tramo de escalera repartida entre sus dos extremos.
"""
import math
import struct
import zlib

import numpy as np

WALK = 75 / 60          # m/s en llano (como la web)
PASO = 5.0              # se mira la altura cada 5 m
MAX_P = 0.35            # pendientes mayores se toman como del 35 % (ruido del terreno)
LLANO_BAJANDO = 0.10    # bajando, hasta el 10 % no se va más despacio

_TIPOS = {1: "B", 2: "s", 3: "H", 4: "I", 5: "II", 11: "f", 12: "d"}


def leer_tif(ruta):
    """GeoTIFF de una banda en tiras (sin comprimir o deflate; predictor 1, 2 o 3)."""
    b = open(ruta, "rb").read()
    e = "<" if b[:2] == b"II" else ">"
    off = struct.unpack(e + "I", b[4:8])[0]
    n = struct.unpack(e + "H", b[off:off + 2])[0]
    tags = {}
    for i in range(n):
        t, ty, cnt, val = struct.unpack(e + "HHI4s", b[off + 2 + 12 * i: off + 14 + 12 * i])
        f = _TIPOS.get(ty)
        if not f:
            continue
        size = struct.calcsize(e + f) * cnt
        data = val if size <= 4 else b[struct.unpack(e + "I", val)[0]:][:size]
        tags[t] = data[:cnt].rstrip(b"\0").decode() if ty == 2 else struct.unpack(e + f * cnt, data[:size])
    W, H = tags[256][0], tags[257][0]
    comp, pred, bps = tags.get(259, (1,))[0], tags.get(317, (1,))[0], tags[258][0]
    fmt = tags.get(339, (1,))[0]          # 1 entero sin signo, 2 con signo, 3 coma flotante
    rps = tags.get(278, (H,))[0]
    tipo = {(16, 2): "i2", (16, 1): "u2", (32, 3): "f4", (32, 2): "i4"}[(bps, fmt)]
    filas = []
    for k, (o, c) in enumerate(zip(tags[273], tags[279])):
        d = b[o:o + c]
        if comp in (8, 32946):
            d = zlib.decompress(d)
        nr = min(rps, H - k * rps)
        bpp = bps // 8
        if pred == 3:
            a = np.frombuffer(d, dtype=np.uint8).reshape(nr, W * bpp)
            a = np.cumsum(a, axis=1, dtype=np.uint8).reshape(nr, bpp, W).transpose(0, 2, 1)
            a = np.ascontiguousarray(a).view(">" + tipo).reshape(nr, W)
        else:
            a = np.frombuffer(d, dtype=e + tipo).reshape(nr, W)
            if pred == 2:
                a = np.cumsum(a, axis=1, dtype=a.dtype)
        filas.append(a.astype(tipo))
    arr = np.vstack(filas)
    sx, sy = tags[33550][:2]
    x0, y0 = tags[33922][3:5]
    nodata = float(tags[42113]) if 42113 in tags else None
    return arr, (x0, sx, y0, sy), nodata


class Relieve:
    def __init__(self, ruta):
        a, (self.x0, self.sx, self.y0, self.sy), nd = leer_tif(ruta)
        z = a.astype("f8")
        if a.dtype.kind == "i":
            z[a == (nd if nd is not None else -32768)] = np.nan
            z /= 10.0           # decímetros → metros
        self.z = z
        self.H, self.W = z.shape

    def altura(self, lat, lon):
        """Altura en metros (interpolación bilineal); None fuera de la zona o en el mar."""
        c = (lon - self.x0) / self.sx - 0.5
        r = (self.y0 - lat) / self.sy - 0.5
        c0, r0 = math.floor(c), math.floor(r)
        if c0 < 0 or r0 < 0 or c0 + 1 >= self.W or r0 + 1 >= self.H:
            return None
        fc, fr = c - c0, r - r0
        v = self.z[r0:r0 + 2, c0:c0 + 2]
        w = np.array([[(1 - fc) * (1 - fr), fc * (1 - fr)], [(1 - fc) * fr, fc * fr]])
        ok = ~np.isnan(v)
        if not ok.any():
            return None
        return float((v[ok] * w[ok]).sum() / w[ok].sum())


def factor(p):
    """Cuánto más se tarda que en llano por metro, con pendiente p (positiva = subiendo)."""
    p = max(-MAX_P, min(MAX_P, p))
    if p >= 0:
        return math.exp(3.5 * p)
    return math.exp(3.5 * (-p - LLANO_BAJANDO)) if -p > LLANO_BAJANDO else 1.0


def coste(perfil):
    """perfil: [(metros desde el inicio, altura)]. Devuelve (ida, vuelta) en metros equivalentes."""
    ida = vuelta = 0.0
    for (d0, z0), (d1, z1) in zip(perfil, perfil[1:]):
        d = d1 - d0
        if d <= 0:
            continue
        p = (z1 - z0) / d
        ida += d * factor(p)
        vuelta += d * factor(-p)
    return ida, vuelta
