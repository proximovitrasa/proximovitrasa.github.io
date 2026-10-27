/* Calcula los transbordos a pie entre paradas cercanas y los guarda en data/viajes.json.
   Uso (después de tools/actualizar_viajes.py):  node tools/transbordos.js
   Distancia por la red peatonal propia (data/peatonal.json), no en línea recta: así no se proponen
   transbordos que obligan a rodear una autovía o la vía del tren. Se guardan los metros
   equivalentes (el tiempo a pie, con las cuestas: ver js/peaton.js); el límite de 300 m es de
   metros reales.
   Con Vigo Vertical (data/vigo-vertical.json): "transbordos" se calcula con todos los elementos
   parados (andando), y "transbordos_vv" guarda los que salen más cortos con alguno funcionando:
   [desde, hasta, metros equivalentes, de ellos sin andar, [ids de los elementos]]. El planificador
   solo los usa si esos elementos funcionan a la hora del cambio. */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const PEATON = require(path.join(ROOT, "js", "peaton.js"));

const MAX = 300;          // metros a pie como máximo entre las dos paradas de un transbordo

const viajes = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "viajes.json"), "utf8"));
const gj = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "paradas.geojson"), "utf8"));
const ll = new Map(gj.features.map((f) => [f.properties.id, [f.geometry.coordinates[1], f.geometry.coordinates[0]]]));
const vvPath = path.join(ROOT, "data", "vigo-vertical.json");
const vv = fs.existsSync(vvPath) ? JSON.parse(fs.readFileSync(vvPath, "utf8")) : null;
const net = PEATON.build(JSON.parse(fs.readFileSync(path.join(ROOT, "data", "peatonal.json"), "utf8")), vv);

const ids = viajes.paradas;
const pts = ids.map((id) => ll.get(id));
const snaps = pts.map((p) => net.snap(p[0], p[1]));
const R = 6371000, rad = Math.PI / 180;
const recta = (a, b) => {
  const x = (b[1] - a[1]) * rad * Math.cos(((a[0] + b[0]) / 2) * rad), y = (b[0] - a[0]) * rad;
  return Math.hypot(x, y) * R;
};

const t0 = Date.now();
function calcular(abiertos) {
  net.setVertical(() => abiertos);
  const r = new Map();
  for (let i = 0; i < ids.length; i++) {
    const dist = net.around(pts[i], MAX * 4);
    for (let j = 0; j < ids.length; j++) {
      if (i === j || recta(pts[i], pts[j]) > MAX) continue;
      const [eq, m, mm] = dist(pts[j], snaps[j], true);
      if (m <= MAX) r.set(i * 100000 + j, [i, j, Math.round(eq), Math.round(mm)]);
    }
  }
  return r;
}
const parados = calcular(false);
const out = [];
for (const [i, j, eq] of parados.values()) out.push(i, j, eq);
const pares = out.length / 3;
viajes.transbordos = out;
const conVV = [];
if (vv) {
  for (const [k, [i, j, eq, mm]] of calcular(true)) {
    const p = parados.get(k);
    if (!mm || (p && p[2] <= eq + 1)) continue;
    const r = net.route(pts[i], pts[j]);
    const els = [...new Set(r.parts.filter((x) => x.used).map((x) => x.el.id))];
    if (els.length) conVV.push([i, j, eq, mm, els]);
  }
  net.setVertical(() => true);
}
viajes.transbordos_vv = conVV;
fs.writeFileSync(path.join(ROOT, "data", "viajes.json"), JSON.stringify(viajes));
console.log(`${pares} transbordos a pie (≤${MAX} m) entre ${ids.length} paradas, ${conVV.length} más cortos con Vigo Vertical, en ${Date.now() - t0} ms`);
