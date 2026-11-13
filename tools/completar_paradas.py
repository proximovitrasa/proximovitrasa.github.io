"""Añade a la lista oficial de paradas las que usan los viajes del GTFS y aún no están en ella.

La lista de paradas del Concello (paradas.json) va por detrás del GTFS de Vitrasa: el 13/11/2026 el
GTFS ya traía las paradas provisionales de los desvíos del Nadal (Marqués de Valladares 19 = 20206,
Colón 12 = 20208) y la lista no. Sin ellas, actualizar_viajes.py las saltaba y Cómo llegar no podía
subir ni bajar allí.

Para cada parada del GTFS (stops.txt) con algún viaje (stop_times.txt) cuyo número (stop_code
"PA20206" o "P006620" → 20206 o 6620) no esté en la lista, se añade una entrada con el mismo formato
que las oficiales (id, stop_id, nombre, lat, lon y las líneas de sus viajes) y "origen": "gtfs".
Si el Concello la añade más tarde, la suya sustituye a esta en la siguiente actualización.

Uso:
    python3 tools/completar_paradas.py data/oficial/paradas.json /tmp/fuentes/gtfs_vigo.zip
"""
import csv
import io
import json
import re
import sys
import zipfile
from collections import defaultdict
from pathlib import Path


def leer(z, nombre):
    with z.open(nombre) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"), skipinitialspace=True)


def main(lista, gtfs_zip):
    ruta = Path(lista)
    paradas = [p for p in json.loads(ruta.read_text(encoding="utf-8")) if p.get("origen") != "gtfs"]
    ya = {str(p["id"]) for p in paradas}
    z = zipfile.ZipFile(gtfs_zip)
    rutas = {r["route_id"]: r["route_short_name"].strip() for r in leer(z, "routes.txt")}
    viaje_ruta = {v["trip_id"]: rutas.get(v["route_id"], "") for v in leer(z, "trips.txt")}
    lineas = defaultdict(list)
    for st in leer(z, "stop_times.txt"):
        l = viaje_ruta.get(st["trip_id"])
        if l and l not in lineas[st["stop_id"]]:
            lineas[st["stop_id"]].append(l)
    nuevas = []
    for s in leer(z, "stops.txt"):
        m = re.fullmatch(r"P[A-Z]*0*(\d+)", (s.get("stop_code") or "").strip())
        if not m or m.group(1) in ya or s["stop_id"] not in lineas:
            continue
        nuevas.append({
            "lineas": ", ".join(lineas[s["stop_id"]]),
            "stop_id": s["stop_id"],
            "lon": float(s["stop_lon"]),
            "id": int(m.group(1)),
            "nombre": s["stop_name"],
            "lat": float(s["stop_lat"]),
            "origen": "gtfs",
        })
        ya.add(m.group(1))
    ruta.write_text(json.dumps(paradas + nuevas, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for p in nuevas:
        print(f"Añadida desde el GTFS: {p['id']} {p['nombre']} ({p['lineas']})")
    print(f"{len(nuevas)} paradas del GTFS que no estaban en la lista oficial")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
