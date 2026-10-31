// Cuenta (67) cuántos tramos en bus de las opciones de Cómo llegar se quedan con el horario publicado,
// en vez del dato en vivo, porque no hay certeza de que el bus en vivo llegue a la bajada:
//  - letrero conocido (está en el horario): liveReaches = "mixed" o "no";
//  - letrero desconocido (la API usa un texto que no está en el horario): no todos los viajes de esa
//    línea y sentido que pasan a esa hora por la subida llegan a la bajada.
// Trayectos al azar (como probar_planificador), un miércoles de 7 a 22 h.
// Uso: node tools/contar_certeza.js [número de trayectos]
const path = require("path"), fs = require("fs");
const repo = path.join(__dirname, "..");
const R = (p) => require(path.join(repo, p));
const peaton = R("js/peaton.js").build(R("data/peatonal.json"));
const P = R("js/planificador.js").build(R("data/viajes.json"));
const paradas = JSON.parse(fs.readFileSync(path.join(repo, "data/paradas.geojson"), "utf8")).features.map((f) => ({ id: String(f.properties.id), ll: [f.geometry.coordinates[1], f.geometry.coordinates[0]] }));
const hav = (a, b) => { const r = Math.PI / 180, dl = (b[0] - a[0]) * r, dn = (b[1] - a[1]) * r; const h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dn / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
function stopsAround(ll, toward) { for (const max of [1000, 1600]) { const dist = peaton.around(ll, max, toward); const out = new Map();
  for (const s of paradas) { const i = P.index.get(s.id); if (i == null || hav(ll, s.ll) > max) continue; const m = dist(s.ll); if (m <= max) out.set(i, m); } if (out.size) return out; } return new Map(); }
let seed = 4242; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const jitter = (ll) => [ll[0] + (rnd() - 0.5) * 0.012, ll[1] + (rnd() - 0.5) * 0.016];
const goes = (pt, b, a) => { const i = pt.p.indexOf(b); return i >= 0 && pt.p.indexOf(a, i + 1) > i; };
const N = Number(process.argv[2] || 400);
let trayectos = 0, opciones = 0, tramos = 0, conocidoNo = 0, desconocidoNo = 0, opcConocido = 0, opcDesconocido = 0;
const porLinea = new Map();
for (let i = 0; i < N; i++) {
  const a = jitter(paradas[Math.floor(rnd() * paradas.length)].ll), b = jitter(paradas[Math.floor(rnd() * paradas.length)].ll);
  if (hav(a, b) < 1500) continue;
  const o = stopsAround(a), d = stopsAround(b, true);
  const time = new Date(2026, 9, 21, 7 + Math.floor(rnd() * 15), Math.floor(rnd() * 60));
  const base = new Date(2026, 9, 21).getTime();
  const opts = P.choose(P.search({ origins: o, dests: d, walk: Infinity, time, maxTransfers: 2 }), time);
  if (!opts.length) continue;
  trayectos++;
  for (const j of opts) {
    opciones++;
    let k1 = false, k2 = false;
    for (const l of j.legs) {
      if (l.type !== "bus") continue;
      tramos++;
      const when = new Date(base + l.dep * 1000);
      const h = (P.pats[l.pat].h || [])[0];
      const r = h ? P.liveReaches(l, h, when) : "unknown";
      if (r !== "yes") { conocidoNo++; k1 = true; porLinea.set(l.line, (porLinea.get(l.line) || 0) + 1); }
      // Letrero desconocido: todos los viajes de la línea y sentido en ±20 min por la subida llegan.
      const near = P.upcoming(l.board, when, 1200, 1200).filter((x) => P.pats[x.pat].l === l.line && P.pats[x.pat].s === l.dir);
      if (!near.length || !near.every((x) => goes(P.pats[x.pat], l.board, l.alight))) { desconocidoNo++; k2 = true; }
    }
    if (k1) opcConocido++;
    if (k2) opcDesconocido++;
  }
}
const pc = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(1)} %`;
console.log(`Trayectos: ${trayectos} · opciones: ${opciones} · tramos en bus: ${tramos}`);
console.log(`Con el letrero del horario, sin certeza (se usa el horario): ${conocidoNo} tramos (${pc(conocidoNo, tramos)}); opciones afectadas: ${opcConocido} (${pc(opcConocido, opciones)})`);
console.log(`Si la API diese un letrero desconocido, sin certeza: ${desconocidoNo} tramos (${pc(desconocidoNo, tramos)}); opciones afectadas: ${opcDesconocido} (${pc(opcDesconocido, opciones)})`);
console.log("Líneas con más tramos sin certeza (letrero conocido):", [...porLinea].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([l, n]) => `${l} ${n}`).join(", "));
