#!/usr/bin/env python3
"""Genera data/peatonal.json: la red de calles y caminos por los que se puede ir a pie.

Entrada: las vías de OpenStreetMap de la zona de Vitrasa, en el formato JSON de Overpass
(data/osm/vias.json.gz, descargado con el GitHub Action "Descargar OSM").

    python3 tools/actualizar_peatonal.py [data/osm/vias.json.gz]

Qué vías se usan: las mismas reglas generales que el perfil "a pie" de OSRM (el que usa
routing.openstreetmap.de), para que los resultados sean comparables:
  - calles, aceras, sendas, escaleras, zonas peatonales, pistas, etc.;
  - autovías y vías rápidas solo si están marcadas como transitables a pie;
  - fuera las vías privadas, prohibidas a peatones, en obras o en proyecto.

Formato de salida (compacto, para que la web lo cargue rápido):
  {
    "v": 1,
    "fuente": "...", "fecha": "AAAA-MM-DD",
    "nodos": [lat0, lon0, dlat1, dlon1, ...],   cruces; enteros en 1e-5 grados, diferencias
    "aristas": [a, b, metros*10, tipo, ida*10, vuelta*10, ...],   6 enteros por tramo entre dos cruces
    "formas": ["polilínea", ...]                  puntos intermedios de cada tramo (Google, precisión 5)
  }
  tipo: 0 normal, 1 escaleras, 2 sin asfaltar (pistas, sendas de tierra...).
  ida / vuelta: metros de más por las cuestas de a → b y de b → a (tools/relieve.py): el tramo
  "cuesta" lo mismo que andar metros + ida en llano. Sin relieve, 0.

Relieve: data/relieve/mdt_vigo.tif (MDT05 del IGN, CC BY 4.0). Los puentes y túneles no siguen el
terreno: su altura se interpola entre sus dos extremos.

Datos © colaboradores de OpenStreetMap, licencia ODbL (https://www.openstreetmap.org/copyright).
El archivo generado es una base de datos derivada y se distribuye con la misma licencia.
"""
import datetime
import gzip
import json
import math
import re
import os
import sys
from collections import defaultdict

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRADA = sys.argv[1] if len(sys.argv) > 1 else os.path.join(RAIZ, "data/osm/vias.json.gz")
SALIDA = os.path.join(RAIZ, "data/peatonal.json")
RELIEVE = os.path.join(RAIZ, "data/relieve/mdt_vigo.tif")
sys.path.insert(0, os.path.join(RAIZ, "tools"))

# ---------- Reglas de acceso a pie (inspiradas en el perfil foot.lua de OSRM) ----------
PERMITIDAS = {
    "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
    "unclassified", "residential", "road", "living_street", "service", "track", "path",
    "steps", "pedestrian", "platform", "footway", "pier", "corridor",
}
SOLO_CON_PERMISO = {"trunk", "trunk_link", "motorway", "motorway_link", "cycleway", "bridleway", "busway"}
SI_PIE = {"yes", "designated", "permissive", "official"}
NO_PIE = {"no", "private", "use_sidepath", "discouraged"}
NO_ACCESO = {"no", "private", "agricultural", "forestry", "delivery", "military"}


ASFALTO = {"paved", "asphalt", "concrete", "concrete:plates", "concrete:lanes", "paving_stones", "sett",
           "cobblestone", "unhewn_cobblestone", "metal", "wood", "chipseal", "bricks"}
TIERRA = {"unpaved", "gravel", "fine_gravel", "compacted", "dirt", "earth", "ground", "grass", "mud",
          "sand", "pebblestone", "rock", "woodchips", "grass_paver"}


def tipo_via(tags):
    """0 normal, 1 escaleras, 2 sin asfaltar (la web las evita un poco al elegir ruta)."""
    h, sup = tags.get("highway"), tags.get("surface", "")
    if h == "steps":
        return 1
    if sup in TIERRA:
        return 2
    if h in ("track", "path", "bridleway") and sup not in ASFALTO:
        return 2
    return 0


AUTOVIA = re.compile(r"^(A|AP|AG|VG|CG|AC)-")
ACERA = {"both", "left", "right", "yes"}


def troncal_urbana(tags):
    """Carreteras nacionales que cruzan barrios (N-552 Avenida de Redondela, N-550 Avenida Domingo
    Bueno…): OSM las marca "trunk" sin decir si se puede andar. Sin ellas, entre dos puntos a 200 m
    a un lado y otro de la avenida salían rodeos de varios kilómetros. Se andan si tienen acera o
    nombre de calle, y nunca si son autovía (por la referencia) o vía para automóviles."""
    if tags.get("motorroad") == "yes" or AUTOVIA.match(tags.get("ref", "")):
        return False
    aceras = {tags.get(k) for k in ("sidewalk", "sidewalk:both", "sidewalk:left", "sidewalk:right")}
    if "no" in aceras and not (aceras & ACERA):
        return False
    if aceras & ACERA:
        return True
    nombre = tags.get("name", "")
    return bool(nombre) and not nombre.startswith(("Viaduto", "Túnel", "Ponte"))


def transitable(tags):
    h = tags.get("highway")
    if not h or h in ("construction", "proposed", "abandoned", "razed", "platform_edge"):
        return False
    if tags.get("area") == "yes" and h not in ("pedestrian", "footway", "platform", "service", "living_street"):
        return False
    foot = tags.get("foot", "")
    if foot in NO_PIE:
        return False
    if h in ("trunk", "trunk_link") and foot not in SI_PIE:
        return troncal_urbana(tags)
    if h in SOLO_CON_PERMISO:
        return foot in SI_PIE
    if h not in PERMITIDAS:
        return foot in SI_PIE
    if tags.get("access") in NO_ACCESO and foot not in SI_PIE:
        return False
    return True


def elevada(tags):
    """Puentes y túneles: no van por el terreno."""
    return tags.get("bridge", "no") != "no" or tags.get("tunnel", "no") not in ("no", "building_passage")


# ---------- Huecos de OSM ----------
# A veces dos vías que en la realidad se tocan no comparten nodo en OSM (p. ej. la plaza y las
# escaleras de Pi y Margall interior, a 1 m de la acera de Pi y Margall pero sin unir): la ruta da
# entonces un rodeo enorme. Se une cada extremo suelto de una vía (y cada nodo de una plaza) con el
# nodo más cercano de otra vía si está a menos de UNIR_M metros y los dos van por el suelo (sin
# puentes ni túneles, misma capa).
UNIR_M = 3.0


def huecos(usadas, coord):
    vias_de = defaultdict(list)
    for i, w in enumerate(usadas):
        for n in w["nodes"]:
            if n in coord:
                vias_de[n].append(i)
    def suelo(i):
        t = usadas[i].get("tags", {})
        return not elevada(t) and t.get("layer", "0") in ("0", "")
    celda = lambda p: (int(p[0] / 0.0001), int(p[1] / 0.0001))
    rejilla = defaultdict(list)
    for n in sorted(vias_de):
        rejilla[celda(coord[n])].append(n)
    cand = set()
    for i, w in enumerate(usadas):
        ns = [n for n in w["nodes"] if n in coord]
        if not ns or not suelo(i):
            continue
        area = w.get("tags", {}).get("area") == "yes" or (len(ns) > 3 and ns[0] == ns[-1] and w["tags"].get("highway") in ("pedestrian", "footway"))
        for n in (ns if area else (ns[0], ns[-1])):
            if len(vias_de[n]) == 1:      # no toca ninguna otra vía
                cand.add(n)
    out, hechos = [], set()
    for n in sorted(cand):
        p, propias = coord[n], set(vias_de[n])
        cy, cx = celda(p)
        mejor = None
        for y in (cy - 1, cy, cy + 1):
            for x in (cx - 1, cx, cx + 1):
                for m in rejilla.get((y, x), ()):
                    if m == n or propias & set(vias_de[m]) or not any(suelo(i) for i in vias_de[m]):
                        continue
                    d = dist(p, coord[m])
                    if d < UNIR_M and (mejor is None or (d, m) < mejor):
                        mejor = (d, m)
        if mejor and (min(n, mejor[1]), max(n, mejor[1])) not in hechos:
            hechos.add((min(n, mejor[1]), max(n, mejor[1])))
            out.append({"type": "way", "id": -len(out) - 1, "nodes": [n, mejor[1]], "tags": {"highway": "footway", "union": "hueco"}})
    return out


# ---------- Geometría ----------
def dist(a, b):
    """Distancia en metros entre dos puntos (lat, lon)."""
    R, r = 6371000.0, math.pi / 180
    dlat, dlon = (b[0] - a[0]) * r, (b[1] - a[1]) * r
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def simplificar(pts, tol=1.5):
    """Douglas-Peucker con tolerancia en metros (proyección local plana)."""
    if len(pts) <= 2:
        return pts
    k = math.cos(math.radians(pts[0][0]))
    xy = [(p[1] * 111320 * k, p[0] * 110540) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    pila = [(0, len(pts) - 1)]
    while pila:
        i, j = pila.pop()
        (x1, y1), (x2, y2) = xy[i], xy[j]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        mejor, idx = -1.0, -1
        for m in range(i + 1, j):
            x, y = xy[m]
            if L2 == 0:
                d = math.hypot(x - x1, y - y1)
            else:
                t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
                d = math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
            if d > mejor:
                mejor, idx = d, m
        if mejor > tol:
            keep[idx] = True
            pila += [(i, idx), (idx, j)]
    return [p for p, k_ in zip(pts, keep) if k_]


def codificar(pts):
    """Polilínea de Google (precisión 5)."""
    out, plat, plon = [], 0, 0
    for lat, lon in pts:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def costes_pares(vias, coord):
    """{(nodo, nodo siguiente): (metros equivalentes de ida, de vuelta)} para cada vía.

    La altura se mira cada PASO metros (en puentes y túneles, interpolada entre los extremos de la
    vía) y se suaviza con la media de tres puntos para quitar ruido del terreno."""
    if not os.path.exists(RELIEVE):
        print("Sin relieve (data/relieve/mdt_vigo.tif): todo llano")
        return {}
    import relieve
    R = relieve.Relieve(RELIEVE)
    cache = {}

    def alt(p):
        k = (round(p[0], 6), round(p[1], 6))
        if k not in cache:
            cache[k] = R.altura(*p)
        return cache[k]

    out = {}
    for w in vias:
        nodos = [n for n in w["nodes"] if n in coord]
        if len(nodos) < 2:
            continue
        pts = [coord[n] for n in nodos]
        largos = [dist(a, b) for a, b in zip(pts, pts[1:])]
        # Muestras: (metros desde el inicio, punto), con las posiciones de cada nodo.
        muestras, pos = [(0.0, pts[0])], [0]
        acum = 0.0
        for (a, b), L in zip(zip(pts, pts[1:]), largos):
            k = max(1, math.ceil(L / relieve.PASO))
            for i in range(1, k + 1):
                f = i / k
                muestras.append((acum + L * f, (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)))
            acum += L
            pos.append(len(muestras) - 1)
        # Puentes y túneles no siguen el terreno; las escaleras suben o bajan sin altibajos (el
        # terreno junto a ellas, con muros y rocas, daría subidas y bajadas falsas).
        if elevada(w.get("tags", {})) or w.get("tags", {}).get("highway") == "steps":
            z0, z1 = alt(pts[0]), alt(pts[-1])
            z0 = z1 if z0 is None else z0
            z1 = z0 if z1 is None else z1
            if z0 is None:
                z = [0.0] * len(muestras)
            else:
                z = [z0 + (z1 - z0) * (d / acum if acum else 0) for d, _ in muestras]
        else:
            z = [alt(p) for _, p in muestras]
            validos = [v for v in z if v is not None]
            if not validos:
                z = [0.0] * len(z)
            else:
                ult = validos[0]
                for i, v in enumerate(z):     # huecos (mar, fuera de la zona): la última conocida
                    if v is None:
                        z[i] = ult
                    else:
                        ult = v
            if len(z) >= 3:
                z = [z[0]] + [(z[i - 1] + z[i] + z[i + 1]) / 3 for i in range(1, len(z) - 1)] + [z[-1]]
        for i in range(len(nodos) - 1):
            perfil = [(muestras[m][0], z[m]) for m in range(pos[i], pos[i + 1] + 1)]
            ida, vuelta = relieve.coste(perfil)
            if (nodos[i], nodos[i + 1]) not in out:
                out[(nodos[i], nodos[i + 1])] = (ida, vuelta)
                out[(nodos[i + 1], nodos[i])] = (vuelta, ida)
    return out


def main():
    with gzip.open(ENTRADA, "rt", encoding="utf-8") as f:
        osm = json.load(f)
    fecha = (osm.get("osm3s", {}).get("timestamp_osm_base") or "")[:10] or datetime.date.today().isoformat()

    coord = {}
    vias = []
    for e in osm["elements"]:
        if e["type"] == "node":
            coord[e["id"]] = (e["lat"], e["lon"])
        elif e["type"] == "way":
            vias.append(e)
    usadas = [w for w in vias if transitable(w.get("tags", {}))]
    print(f"Vías en la descarga: {len(vias)}; transitables a pie: {len(usadas)}")
    uniones = huecos(usadas, coord)
    usadas += uniones
    print(f"Huecos de OSM unidos (< {UNIR_M} m): {len(uniones)}")

    # Cruces: extremos de cada vía y nodos compartidos por varias vías.
    uso = defaultdict(int)
    for w in usadas:
        for n in w["nodes"]:
            uso[n] += 1
    cruce = set()
    for w in usadas:
        cruce.add(w["nodes"][0])
        cruce.add(w["nodes"][-1])
    cruce |= {n for n, c in uso.items() if c > 1}

    # Cuestas: coste de ida y vuelta (metros equivalentes) de cada par de nodos consecutivos.
    par = costes_pares(usadas, coord)

    # Tramos entre cruces.
    tramos = []  # (a, b, [nodos osm], tipo)
    for w in usadas:
        tipo = tipo_via(w["tags"])
        nodos = [n for n in w["nodes"] if n in coord]
        ini = 0
        for i in range(1, len(nodos)):
            if nodos[i] in cruce or i == len(nodos) - 1:
                seg = nodos[ini:i + 1]
                if len(seg) >= 2 and seg[0] != seg[-1]:
                    tramos.append([seg[0], seg[-1], seg, tipo])
                elif len(seg) >= 3:  # bucle cerrado (p. ej. plaza): partirlo en dos
                    mid = len(seg) // 2
                    cruce.add(seg[mid])
                    tramos.append([seg[0], seg[mid], seg[:mid + 1], tipo])
                    tramos.append([seg[mid], seg[-1], seg[mid:], tipo])
                ini = i

    # Componente conexa más grande (las islas sueltas no sirven para ir a ningún sitio).
    adj = defaultdict(list)
    for t in tramos:
        adj[t[0]].append(t[1])
        adj[t[1]].append(t[0])
    visto, mejor = set(), set()
    for n in adj:
        if n in visto:
            continue
        comp, pila = {n}, [n]
        visto.add(n)
        while pila:
            u = pila.pop()
            for v in adj[u]:
                if v not in visto:
                    visto.add(v)
                    comp.add(v)
                    pila.append(v)
        if len(comp) > len(mejor):
            mejor = comp
    tramos = [t for t in tramos if t[0] in mejor]
    print(f"Componente principal: {len(mejor)} cruces de {len(adj)}")

    # Unir tramos encadenados (nodos con exactamente dos tramos del mismo tipo).
    inc = defaultdict(list)
    for i, t in enumerate(tramos):
        inc[t[0]].append(i)
        inc[t[1]].append(i)
    vivo = [True] * len(tramos)
    for n in list(inc):
        lst = [i for i in inc[n] if vivo[i]]
        if len(lst) != 2 or lst[0] == lst[1]:
            continue
        i, j = lst
        ti, tj = tramos[i], tramos[j]
        if ti[3] != tj[3]:
            continue
        a = ti[2] if ti[1] == n else ti[2][::-1]   # termina en n
        b = tj[2] if tj[0] == n else tj[2][::-1]   # empieza en n
        seg = a + b[1:]
        if seg[0] == seg[-1]:
            continue
        tramos[i] = [seg[0], seg[-1], seg, ti[3]]
        vivo[j] = False
        for extremo in (tj[0], tj[1]):
            if extremo != n:
                inc[extremo] = [i if x == j else x for x in inc[extremo]]
        inc[n] = []
    tramos = [t for t, v in zip(tramos, vivo) if v]

    # Quitar duplicados (mismo par de cruces): se queda el más corto.
    porpar = {}
    for t in tramos:
        pts = [coord[n] for n in t[2]]
        L = sum(dist(pts[k], pts[k + 1]) for k in range(len(pts) - 1))
        clave = (min(t[0], t[1]), max(t[0], t[1]))
        if clave not in porpar or L < porpar[clave][0]:
            porpar[clave] = (L, t, pts)

    # Numeración compacta de cruces, ordenados para que las diferencias sean pequeñas.
    usados = sorted({n for L, t, p in porpar.values() for n in (t[0], t[1])},
                    key=lambda n: (round(coord[n][0] * 200), coord[n][1]))
    idx = {n: i for i, n in enumerate(usados)}
    nodos, plat, plon = [], 0, 0
    for n in usados:
        lat, lon = round(coord[n][0] * 1e5), round(coord[n][1] * 1e5)
        nodos += [lat - plat, lon - plon]
        plat, plon = lat, lon

    aristas, formas = [], []
    total = 0.0
    subida = 0.0
    for L, t, pts in porpar.values():
        inter = simplificar(pts)[1:-1]
        ida = vuelta = 0.0
        for u, v, a_, b_ in zip(t[2], t[2][1:], pts, pts[1:]):
            c = par.get((u, v))
            if c is None:
                d = dist(a_, b_)
                c = (d, d)
            ida += c[0]
            vuelta += c[1]
        L10 = max(1, round(L * 10))
        aristas += [idx[t[0]], idx[t[1]], L10, t[3], max(0, round(ida * 10) - L10), max(0, round(vuelta * 10) - L10)]
        subida += max(ida, vuelta) - L
        formas.append(codificar(inter) if inter else "")
        total += L

    salida = {
        "v": 2,
        "fuente": "© colaboradores de OpenStreetMap (ODbL), vías de la zona de Vitrasa",
        "fecha": fecha,
        "nodos": nodos,
        "aristas": aristas,
        "formas": formas,
    }
    with open(SALIDA, "w", encoding="utf-8") as f:
        json.dump(salida, f, separators=(",", ":"), ensure_ascii=False)
    tam = os.path.getsize(SALIDA)
    comp = len(gzip.compress(open(SALIDA, "rb").read(), 9))
    print(f"Red peatonal: {len(usados)} cruces, {len(formas)} tramos, {total / 1000:.0f} km"
          f" (+{subida / 1000:.0f} km equivalentes por cuestas, en el sentido peor)")
    print(f"{SALIDA}: {tam / 1e6:.2f} MB ({comp / 1e6:.2f} MB comprimido)")


if __name__ == "__main__":
    main()
