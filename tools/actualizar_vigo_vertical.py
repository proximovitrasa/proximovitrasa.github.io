#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only · © 2026 asergom · ver LICENSE y TERMINOS-ADICIONALES.md
"""Genera data/vigo-vertical.json: rampas, escaleras mecánicas y ascensores del Vigo Vertical.

Entradas (datos propios, no de OpenStreetMap):
  data/vigo-vertical/vigo-vertical.kml   geometría (Google Earth): rampas, escaleras y el ascensor
                                         inclinado como líneas de A a B; ascensores como un punto.
  data/vigo-vertical/elementos.json      nombre, tipo, horario y página oficial de cada elemento.
  data/peatonal.json                     red peatonal, para enganchar cada elemento a las calles.
  data/relieve/mdt_vigo.tif              relieve: qué extremo está arriba y cuánto se sube.

    python3 tools/actualizar_vigo_vertical.py

Cada elemento se convierte en un atajo entre dos puntos de la red peatonal, "a" (abajo) y "b"
(arriba), que la web (js/peaton.js) añade a la red según la hora:
  - rampas y escaleras mecánicas: subiendo y en horario, al doble de la velocidad a pie (la
    cinta); bajando, o fuera de horario, se andan como una cuesta normal;
  - ascensores (y el inclinado): en los dos sentidos, solo en horario; tiempo = espera media +
    recorrido. Un ascensor vertical es un punto: se engancha a la calle más baja y a la más alta
    que tiene cerca (o a los puntos fijados a mano en elementos.json: "abajo"/"arriba").
Tiempos en "metros equivalentes" (los que se andarían en llano a 4,5 km/h en el mismo tiempo).
"""
import json
import math
import os
import re
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(RAIZ, "tools"))
import relieve  # noqa: E402

KML = os.path.join(RAIZ, "data/vigo-vertical/vigo-vertical.kml")
ELEMENTOS = os.path.join(RAIZ, "data/vigo-vertical/elementos.json")
SALIDA = os.path.join(RAIZ, "data/vigo-vertical.json")

WALK = relieve.WALK
ESPERA = 45            # s de espera media a un ascensor
V_ASCENSOR = 1.0       # m/s (vertical: de desnivel; inclinado: a lo largo)
V_CINTA = 2            # rampas y escaleras mecánicas: el doble de la velocidad a pie
RADIO = 45             # m alrededor de un ascensor en los que se buscan sus dos calles
MIN_DZ = 3             # m: un ascensor debe unir dos calles con al menos este desnivel
LEJOS = 25             # m: aviso si un extremo queda más lejos de la red


def dist(a, b):
    k = math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((b[0] - a[0]) * 110540, (b[1] - a[1]) * 111320 * k)


def leer_kml():
    k = open(KML, encoding="utf-8").read()
    out = []
    for pid, nombre, geo, cs in re.findall(
            r'<Placemark id="([^"]+)">\s*<name>([^<]*)</name>.*?<(LineString|Point)>.*?<coordinates>\s*([^<]+?)\s*</coordinates>',
            k, re.S):
        pts = []
        for c in cs.split():
            lon, lat = map(float, c.split(",")[:2])
            pts.append((lat, lon))
        out.append({"id": pid, "kml": nombre.strip(), "geo": geo, "pts": pts})
    return out


def decodificar(s):
    out, i, lat, lng = [], 0, 0, 0
    while i < len(s):
        vals = []
        for _ in range(2):
            shift = res = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                res |= (b & 31) << shift
                shift += 5
                if b < 32:
                    break
            vals.append(~(res >> 1) if res & 1 else res >> 1)
        lat += vals[0]
        lng += vals[1]
        out.append((lat / 1e5, lng / 1e5))
    return out


class Red:
    """Trozos de la red peatonal con un índice por celdas, para buscar el punto más cercano."""

    def __init__(self):
        d = json.load(open(os.path.join(RAIZ, "data/peatonal.json")))
        nodos, la, lo = [], 0, 0
        for i in range(0, len(d["nodos"]), 2):
            la += d["nodos"][i]
            lo += d["nodos"][i + 1]
            nodos.append((la / 1e5, lo / 1e5))
        W = 6 if d.get("v", 1) >= 2 else 4
        A = d["aristas"]
        self.trozos = []        # (p, q, arista)
        self.celdas = {}
        for e in range(len(A) // W):
            pts = [nodos[A[W * e]]] + decodificar(d["formas"][e]) + [nodos[A[W * e + 1]]]
            for p, q in zip(pts, pts[1:]):
                t = len(self.trozos)
                self.trozos.append((p, q, e))
                for c in self._celdas(p, q):
                    self.celdas.setdefault(c, []).append(t)

    @staticmethod
    def _celdas(p, q):
        x0, x1 = sorted((int(p[1] / 0.001), int(q[1] / 0.001)))
        y0, y1 = sorted((int(p[0] / 0.001), int(q[0] / 0.001)))
        return [(y, x) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]

    def cerca(self, p, radio):
        """[(distancia, punto de la red, arista)] de cada arista a menos de radio metros."""
        mejor = {}
        r = int(radio / 100) + 1
        cy, cx = int(p[0] / 0.001), int(p[1] / 0.001)
        vistos = set()
        k = math.cos(math.radians(p[0]))
        for y in range(cy - r, cy + r + 1):
            for x in range(cx - r, cx + r + 1):
                for t in self.celdas.get((y, x), ()):
                    if t in vistos:
                        continue
                    vistos.add(t)
                    a, b, e = self.trozos[t]
                    ax, ay = (a[1] - p[1]) * 111320 * k, (a[0] - p[0]) * 110540
                    bx, by = (b[1] - p[1]) * 111320 * k, (b[0] - p[0]) * 110540
                    dx, dy = bx - ax, by - ay
                    L2 = dx * dx + dy * dy
                    f = max(0.0, min(1.0, -(ax * dx + ay * dy) / L2)) if L2 else 0.0
                    d = math.hypot(ax + f * dx, ay + f * dy)
                    if d <= radio and (e not in mejor or d < mejor[e][0]):
                        mejor[e] = (d, (a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])), e)
        return sorted(mejor.values())

    def enganchar(self, p, radio=200):
        c = self.cerca(p, radio)
        return c[0] if c else None


def r5(p):
    return [round(p[0], 6), round(p[1], 6)]


def main():
    datos = json.load(open(ELEMENTOS, encoding="utf-8"))
    R = relieve.Relieve(os.path.join(RAIZ, "data/relieve/mdt_vigo.tif"))
    red = Red()
    salida, avisos = [], []
    for el in leer_kml():
        info = datos["elementos"].get(el["id"])
        if not info:
            avisos.append(f"{el['id']} ({el['kml']}): sin datos en elementos.json; no se usa")
            continue
        tipo, nombre = info["tipo"], info["nombre"]
        o = {"id": el["id"], "n": nombre, "t": tipo, "h": info["horario"]}
        if info.get("web"):
            o["w"] = info["web"]
        if tipo in ("rampa", "escalera", "inclinado"):
            p0, p1 = el["pts"][0], el["pts"][-1]
            z0, z1 = R.altura(*p0), R.altura(*p1)
            if z0 > z1:
                p0, p1, z0, z1 = p1, p0, z1, z0
            L = sum(dist(a, b) for a, b in zip(el["pts"], el["pts"][1:]))
            ga, gb = red.enganchar(p0), red.enganchar(p1)
            o.update(ka=r5(p0), kb=r5(p1), dz=round(z1 - z0, 1), L=round(L, 1))
            if tipo == "inclinado":
                o["m"] = round(WALK * (ESPERA + L / V_ASCENSOR), 1)
            else:
                # En horario y subiendo: la cinta. Si no, andando por la cuesta.
                o["m"] = round(L / V_CINTA, 1)
                perfil = [(L * i / 10, z0 + (z1 - z0) * i / 10) for i in range(11)]
                sube, baja = relieve.coste(perfil)
                o["wu"], o["wd"] = round(sube, 1), round(baja, 1)
        else:  # ascensor vertical: un punto
            p = el["pts"][0]
            o["ka"] = o["kb"] = r5(p)
            if "abajo" in info and "arriba" in info:
                ga, gb = red.enganchar(tuple(info["abajo"])), red.enganchar(tuple(info["arriba"]))
            else:
                cand = [(d, q, e, R.altura(*q)) for d, q, e in red.cerca(p, RADIO)]
                cand = [c for c in cand if c[3] is not None]
                if not cand:
                    avisos.append(f"{nombre}: sin calles a menos de {RADIO} m; no se usa")
                    continue
                # La más baja y la más alta, prefiriendo las cercanas (1 m de altura ≈ 10 m de distancia).
                ga = min(cand, key=lambda c: c[3] + c[0] / 10)
                gb = max(cand, key=lambda c: c[3] - c[0] / 10)
            za, zb = R.altura(*ga[1]), R.altura(*gb[1])
            dz = (info.get("desnivel") or (zb - za))
            if dz < MIN_DZ:
                avisos.append(f"{nombre}: las calles de alrededor solo tienen {dz:.1f} m de desnivel; revisar")
            o["dz"] = round(dz, 1)
            o["m"] = round(WALK * (ESPERA + max(dz, 0) / V_ASCENSOR), 1)
        o["a"], o["b"] = r5(ga[1]), r5(gb[1])
        # Lo que se anda desde la red hasta el elemento (y desde el elemento hasta la red).
        o["wa"], o["wb"] = round(dist(ga[1], tuple(o["ka"])), 1), round(dist(tuple(o["kb"]), gb[1]), 1)
        for lado, g in (("abajo", ga), ("arriba", gb)):
            if tipo != "ascensor" and g[0] > LEJOS:
                avisos.append(f"{nombre}: extremo de {lado} a {g[0]:.0f} m de la red")
        if info.get("confirmar"):
            o["c"] = info["confirmar"]
        salida.append(o)

    horarios = {k: {"dias": v["dias"], "vispera": v["vispera"]} for k, v in datos["horarios"].items()}
    out = {"v": 1, "fuente": "Vigo Vertical (Concello de Vigo): datos propios de ProximoVitrasa",
           "horarios": horarios, "elementos": salida}
    with open(SALIDA, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{SALIDA}: {len(salida)} elementos ({os.path.getsize(SALIDA) / 1000:.1f} KB)")
    for t in ("rampa", "escalera", "ascensor", "inclinado"):
        print(f"  {t}: {sum(1 for o in salida if o['t'] == t)}")
    for a in avisos:
        print("AVISO:", a)


if __name__ == "__main__":
    main()
