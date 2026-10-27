#!/usr/bin/env python3
"""Temporal: descarga el MDT de 5 m del IGN (LiDAR, sin edificios) de la zona de Vitrasa.

Prueba varias formas de pedirlo (OGC API Coverages y WCS del IGN), descarga por trozos,
los une y guarda fuentes/mdt_vigo.tif: rejilla en grados (EPSG:4326), ~5,5 m, enteros en
decímetros (int16), -32768 = sin dato. Lo ejecuta el Action temporal "Descargar relieve".
Datos: © Instituto Geográfico Nacional (CC BY 4.0).
"""
import io
import sys
import time
import urllib.parse
import urllib.request

import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.merge import merge
from rasterio.warp import Resampling, reproject, transform_bounds

ZONA = (-8.845, 42.105, -8.585, 42.300)       # oeste, sur, este, norte
PASO = 0.025                                 # trozos de 0,025° (~2,1 × 2,8 km)
UA = {"User-Agent": "proximovitrasa (github.com/proximovitrasa/proximovitrasa.github.io)"}
API = "https://api-coverages.idee.es"
WCS = "https://servicios.idee.es/wcs-inspire/mdt"


def get(url, timeout=180):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.headers.get("Content-Type", ""), r.read()


def probar(url):
    try:
        st, ct, b = get(url)
        print(f"  {st} {ct} {len(b)} B  {url[:220]}")
        if b[:4] in (b"II*\0", b"MM\0*"):
            return b
        print("   ", b[:300])
    except Exception as e:  # noqa: BLE001
        print(f"  ERROR {e}  {url[:220]}")
        try:
            print("   ", e.read()[:300])  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass
    return None


def utm(epsg, w, s, e, n):
    return transform_bounds("EPSG:4326", f"EPSG:{epsg}", w, s, e, n)


def maneras():
    """Formas de pedir un trozo (w, s, e, n) → URL."""
    out = []
    for col in ("EL.ElevationGridCoverage_25829_5", "EL.ElevationGridCoverage_25830_5_PB",
                "EL.ElevationGridCoverage_25830_5"):
        base = f"{API}/collections/{col}/coverage?f=COG"
        out.append((f"api {col} bbox", lambda w, s, e, n, b=base: f"{b}&bbox={w},{s},{e},{n}"))
        epsg = 25829 if "25829" in col else 25830
        out.append((f"api {col} subset utm", lambda w, s, e, n, b=base, ep=epsg: (
            lambda x0, y0, x1, y1: f"{b}&subset=E({x0:.0f}:{x1:.0f})&subset=N({y0:.0f}:{y1:.0f})")(*utm(ep, w, s, e, n))))
        out.append((f"api {col} bbox-crs", lambda w, s, e, n, b=base, ep=epsg: (
            lambda x0, y0, x1, y1: f"{b}&bbox={x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f}&bbox-crs=" +
            urllib.parse.quote(f"http://www.opengis.net/def/crs/EPSG/0/{ep}", safe=""))(*utm(ep, w, s, e, n))))
    for cov, ep in (("Elevacion25829_5", 25829), ("Elevacion25830_5", 25830), ("Elevacion4258_5", 4258)):
        def f(w, s, e, n, cov=cov, ep=ep):
            if ep == 4258:
                x0, y0, x1, y1 = w, s, e, n
                ax = ("Long", "Lat")
                return (f"{WCS}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID={cov}"
                        f"&SUBSET={ax[1]}({y0},{y1})&SUBSET={ax[0]}({x0},{x1})&FORMAT=image/tiff")
            x0, y0, x1, y1 = utm(ep, w, s, e, n)
            return (f"{WCS}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID={cov}"
                    f"&SUBSET=x({x0:.0f},{x1:.0f})&SUBSET=y({y0:.0f},{y1:.0f})&FORMAT=image/tiff")
        out.append((f"wcs {cov}", f))
    return out


def main():
    print("Colecciones del servidor OGC API:")
    try:
        st, ct, b = get(f"{API}/collections?f=json")
        import json
        for c in json.loads(b).get("collections", []):
            print("  ", c.get("id"))
    except Exception as e:  # noqa: BLE001
        print("  ERROR", e)
    print("Capacidades WCS (ids):")
    try:
        st, ct, b = get(f"{WCS}?SERVICE=WCS&REQUEST=GetCapabilities")
        import re
        print("  ", sorted(set(re.findall(rb"CoverageId>([^<]+)<", b)))[:40])
    except Exception as e:  # noqa: BLE001
        print("  ERROR", e)

    prueba = (-8.72, 42.23, -8.71, 42.24)
    elegida = None
    for nombre, f in [m for m in maneras() if m[0] == "wcs Elevacion25830_5"] + maneras():
        print("Probando", nombre)
        b = probar(f(*prueba))
        if b:
            with MemoryFile(b) as m, m.open() as d:
                a = d.read(1)
                print("   OK", d.crs, d.res, a.shape, float(np.nanmin(a)), float(np.nanmax(a)))
                if a.size > 100 and np.nanmax(a) > 0:
                    elegida = (nombre, f)
                    break
    if not elegida:
        sys.exit("Ninguna forma de descarga ha funcionado")
    print("Se usa:", elegida[0])

    trozos = []
    w0, s0, e0, n0 = ZONA
    xs = np.arange(w0, e0, PASO)
    ys = np.arange(s0, n0, PASO)
    for y in ys:
        for x in xs:
            caja = (x - 0.001, y - 0.001, min(x + PASO, e0) + 0.001, min(y + PASO, n0) + 0.001)
            b = None
            for intento in range(4):
                try:
                    st, ct, b = get(elegida[1](*caja), timeout=300)
                    if b[:4] in (b"II*\0", b"MM\0*"):
                        break
                    print("  respuesta rara", caja, st, ct, b[:200])
                    b = None
                except Exception as ex:  # noqa: BLE001
                    print("  fallo", caja, ex)
                time.sleep(3 * (intento + 1))
            if b:
                ruta = f"/tmp/trozo_{len(trozos)}.tif"
                open(ruta, "wb").write(b)
                try:
                    with rasterio.open(ruta) as d:
                        d.read(1)
                    trozos.append(rasterio.open(ruta))
                except Exception as ex:  # noqa: BLE001
                    print("  trozo ilegible", caja, ex)
            else:
                print("  SIN DATOS", caja)
    print(f"{len(trozos)} trozos de {len(xs) * len(ys)}")
    mosaico, tr = merge(trozos, nodata=-9999)
    src_crs = trozos[0].crs

    paso_lat = 0.00005
    paso_lon = 0.0000675
    W = int(round((e0 - w0) / paso_lon))
    H = int(round((n0 - s0) / paso_lat))
    dst = np.full((H, W), -9999, dtype="float32")
    dtr = rasterio.transform.from_origin(w0, n0, paso_lon, paso_lat)
    reproject(mosaico[0].astype("float32"), dst, src_transform=tr, src_crs=src_crs, src_nodata=-9999,
              dst_transform=dtr, dst_crs="EPSG:4326", dst_nodata=-9999, resampling=Resampling.bilinear)
    sin = (dst < -100) | ~np.isfinite(dst)
    out = np.where(sin, -32768, np.round(dst * 10)).astype("int16")
    print("Resultado:", out.shape, "con dato:", int((~sin).sum()), "min/max m:",
          float(dst[~sin].min()), float(dst[~sin].max()))
    perfil = dict(driver="GTiff", width=W, height=H, count=1, dtype="int16", crs="EPSG:4326",
                  transform=dtr, nodata=-32768, compress="deflate", predictor=2, tiled=False)
    with rasterio.open("fuentes/mdt_vigo.tif", "w", **perfil) as d:
        d.write(out, 1)


if __name__ == "__main__":
    main()
