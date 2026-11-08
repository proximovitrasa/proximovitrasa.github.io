// SPDX-License-Identifier: AGPL-3.0-only
// Elige las paradas que consulta el registro de la API (registrar-api.yml) para revisar los ramales
// (tarea 75): con qué letrero da la API cada bus y adónde va de verdad.
//   - Tronco: por cada línea y sentido, paradas por las que pasan sus recorridos (cubrir todos con
//     las menos posibles, prefiriendo las que sirven a varias líneas): ahí se ven todos los letreros.
//   - Ramal: por cada recorrido que se separa de los demás de su línea y sentido, la 2.ª parada que
//     solo tienen él y los que van por el mismo ramal (la 1.ª puede estar junto al cruce): si un bus
//     con letrero X sale ahí, X va por ese ramal.
//   - Fijas: las del caso de la C3i (Policarpo Sanz 25, Praza de Compostela, Avda. de Europa 1860,
//     Eduardo Cabello, Rúa do Porriño).
// Uso: node tools/elegir_paradas_registro.js > tools/registro-paradas.json
const path = require("path");
const repo = path.join(__dirname, "..");
const V = require(path.join(repo, "data/viajes.json"));
const FIJAS = ["20193", "6860", "20195", "1860", "1880", "14124", "14125", "14164"];
const ids = V.paradas.map(String);
const pats = V.patrones.map((p, n) => ({ n, l: p.l, s: p.s, h: p.h || [], p: p.p.map((i) => ids[i]) })).filter((p) => p.p.length > 2);
const groups = new Map();
for (const p of pats) { const k = `${p.l}|${p.s}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }

const why = new Map();   // parada → motivos
const add = (id, m) => { if (!why.has(id)) why.set(id, []); why.get(id).push(m); };
FIJAS.forEach((id) => add(id, "caso C3i"));

// Cuántas líneas distintas pasan por cada parada (para preferir paradas compartidas).
const linesAt = new Map();
for (const p of pats) p.p.slice(0, -1).forEach((id) => { if (!linesAt.has(id)) linesAt.set(id, new Set()); linesAt.get(id).add(p.l); });

// Tronco: cobertura voraz de los recorridos de cada línea y sentido (sin la última parada).
for (const [k, ps] of [...groups].sort()) {
  let left = ps.slice();
  while (left.length) {
    const score = new Map();
    for (const p of left) p.p.slice(0, -1).forEach((id, i) => {
      // en medio del recorrido mejor que en la cabecera (ahí aún no hay bus en marcha)
      const mid = 1 - Math.abs(i / (p.p.length - 1) - 0.5);
      score.set(id, (score.get(id) || 0) + 1 + 0.3 * mid);
    });
    let best = null, bs = -1;
    for (const [id, s] of score) {
      const v = s + (why.has(id) ? 0.5 : 0) + 0.05 * (linesAt.get(id) || new Set()).size;
      if (v > bs || (v === bs && id < best)) { bs = v; best = id; }
    }
    add(best, `tronco ${k}`);
    left = left.filter((p) => !p.p.slice(0, -1).includes(best));
  }
}

// Ramales: recorridos con paradas que no tienen todos los de su línea y sentido.
for (const [k, ps] of [...groups].sort()) {
  if (ps.length < 2) continue;
  const seen = new Set();
  // Por parejas: donde p y q, tras compartir una parada, siguen por sitios distintos (los dos
  // continúan: que uno acabe antes no es un ramal).
  for (const p of ps) for (const q of ps) {
    if (p === q) continue;
    const i = p.p.findIndex((id, i) => i > 0 && !q.p.includes(id) && q.p.includes(p.p[i - 1]) && q.p.indexOf(p.p[i - 1]) < q.p.length - 1);
    if (i < 0) continue;
    const pick = p.p[Math.min(i + 1, p.p.length - 2)] && !q.p.includes(p.p[Math.min(i + 1, p.p.length - 2)]) ? p.p[Math.min(i + 1, p.p.length - 2)] : p.p[i];
    const who = ps.filter((r) => r.p.includes(pick)).map((r) => r.n).sort().join(",");
    if (seen.has(who)) continue;
    seen.add(who);
    add(pick, `ramal ${k} (${[...new Set(ps.filter((r) => r.p.includes(pick)).flatMap((r) => r.h))].join(" / ")})`);
  }
}

const out = [...why].sort((a, b) => a[0].localeCompare(b[0], "es", { numeric: true })).map(([id, m]) => ({ id, motivos: m }));
process.stdout.write(JSON.stringify({ generado: "tools/elegir_paradas_registro.js", fecha_datos: V.fecha, paradas: out }, null, 1) + "\n");
