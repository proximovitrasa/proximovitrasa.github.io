// SPDX-License-Identifier: AGPL-3.0-only
// Prueba del ramal de cada bus en vivo (fase 2 del plan de ramales, tarea 75) con el registro de la
// API (rama prueba-concello, registro/<día>/api-*.jsonl.gz).
//
// Para cada bus que da la API en una parada del registro, con un recorrido dudoso después de ella
// (branchCheck), se decide el ramal como lo haría la web (branchPick con lo que da la API en las
// sondas en esa misma vuelta de consultas) y se compara con lo que hizo el bus de verdad: en qué
// paradas propias de un ramal se le ve pasar después (consultas a ≤ 7 min, mismo letrero, a la hora
// que toca ± 3 min + 20 %).
//
// Uso: TZ=Europe/Madrid node tools/probar_ramales.js api1.jsonl.gz [api2 …]  [--detalle]
const fs = require("fs"), zlib = require("zlib"), path = require("path");
const ROOT = path.join(__dirname, "..");
const PLAN = require(path.join(ROOT, "js/planificador.js"));
const P = PLAN.build(require(path.join(ROOT, "data/viajes.json")));
const lines = require(path.join(ROOT, "data/lineas.json"));
const G = JSON.parse(fs.readFileSync(path.join(ROOT, "data/paradas.geojson")));
const nameOf = new Map(G.features.map((f) => [String(f.properties.id), f.properties.nombre]));
P.setStops(() => null, (id) => nameOf.get(id));

const args = process.argv.slice(2), detalle = args.includes("--detalle");
const files = args.filter((a) => !a.startsWith("--"));
const exact = (s) => String(s || "").replace(/\s+/g, " ").trim();   // letrero tal cual: la verdad, solo con el mismo
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
const normLine = (c) => String(c).trim().replace(/[.\-]+$/, "").trim().replace(/^PSA(\d)/, "PSA $1");
const goesTo = (d, ruta) => !!ruta && (norm(d.destino) === norm(ruta) || (d.letreros || []).some((x) => norm(x) === norm(ruta)));
// Sentido como en la web (app.js): por las paradas de cada sentido y, si pasan los dos, por el letrero.
const liveDir = (id, linea, ruta) => {
  const l = lines[linea]; if (!l) return null;
  const idx = l.sentidos.map((d, i) => (d.paradas.includes(id) || (d.otras || []).includes(id) ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 1) return idx[0];
  const hit = idx.find((i) => goesTo(l.sentidos[i], ruta)); return hit == null ? null : hit;
};
const hh = (T) => new Date(T * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

// ---- Consultas y vueltas (cada ~6 min se consultan todas las paradas)
const rows = [];
for (const f of files) for (const l of zlib.gunzipSync(fs.readFileSync(f)).toString("utf8").split("\n")) {
  if (!l.trim()) continue;
  const r = JSON.parse(l);
  if (!r.error && r.est) rows.push(r);
}
rows.sort((a, b) => a.t - b.t);
const rounds = [];
for (const r of rows) {
  const cur = rounds[rounds.length - 1];
  if (!cur || r.t - cur.t1 > 120 || cur.m.has(r.id)) rounds.push({ t0: r.t, t1: r.t, m: new Map([[r.id, r]]) });
  else { cur.t1 = r.t; cur.m.set(r.id, r); }
}

// ---- Pasos de bus por parada (para la verdad): consultas a ≤ 7 min de un mismo bus juntas
const obs = new Map();
for (const r of rows) for (const x of r.est) {
  const m = Number(x.minutos); if (!isFinite(m) || m > 7) continue;
  const k = `${r.id}|${normLine(x.linea)}|${exact(x.ruta)}`;
  if (!obs.has(k)) obs.set(k, []);
  obs.get(k).push({ T: r.t + m * 60, m, t: r.t });
}
const passes = new Map();
for (const [k, os] of obs) {
  const out = []; let cur = null;
  for (const o of os.sort((a, b) => a.t - b.t)) {
    if (cur && o.t - cur.t <= 450 && (Math.abs(o.T - cur.T) <= 240 || Math.abs(o.m - cur.m) <= 1)) { cur.T = o.T; cur.m = o.m; cur.t = o.t; continue; }
    if (cur) out.push(cur);
    cur = { T: o.T, m: o.m, t: o.t };
  }
  if (cur) out.push(cur);
  passes.set(k, out);
}
const registered = new Set(rows.map((r) => r.id));

// ---- Prueba
const st = { buses: 0, dudosos: 0, sinSondas: 0, conVerdad: 0, bien: 0, mal: 0, sinDecidir: 0 };
const dud = new Map(), nd = new Map(), mb = [0, 0, 0, 0, 0];
const malos = [], sinDecidir = new Map(), resid = [], porLinea = new Map();
for (const rd of rounds) {
  for (const [id, r] of rd.m) {
    const s = P.index.get(id); if (s == null) continue;
    const list = r.est.map((b) => ({ line: normLine(b.linea), ruta: b.ruta, minutos: b.minutos }));
    for (const b of list) {
      const m = Number(b.minutos); if (!isFinite(m) || m > 45) continue;
      const dir = liveDir(id, b.line, b.ruta); if (dir == null) continue;
      st.buses++;
      const when = new Date((r.t + m * 60) * 1000);
      const check = P.branchCheck(s, b.line, dir, b.ruta, when, (u) => registered.has(P.ids[u]));
      if (!check) continue;
      st.dudosos++;
      const dl = dud.get(b.line) || { dudosos: 0, sinSondas: 0, decididos: 0, sinDecidir: 0 }; dud.set(b.line, dl); dl.dudosos++;
      if (!check.probes.length) { st.sinSondas++; dl.sinSondas++; continue; }
      { const lists0 = (u) => { const q = rd.m.get(P.ids[u]); return q ? q.est.map((x) => ({ line: normLine(x.linea), ruta: x.ruta, minutos: x.minutos })) : null; };
        if (P.branchPick(check, b.line, b.ruta, m, lists0).length === 1) dl.decididos++; else { dl.sinDecidir++; mb[Math.min(4, Math.floor(m / 10))]++; const k = `${b.line} "${b.ruta}" en ${id} (${check.routes.length} recorridos)`; nd.set(k, (nd.get(k) || 0) + 1); } }
      // Verdad: paradas propias de algún ramal donde se le ve pasar después con el mismo letrero.
      const seen = new Set();
      check.routes.forEach((rt) => rt.stops.forEach((u, i) => {
        if (check.routes.every((o) => o.stops.includes(u))) return;
        const ps = passes.get(`${P.ids[u]}|${b.line}|${exact(b.ruta)}`); if (!ps) return;
        const T = r.t + m * 60 + rt.offs[i];
        if (ps.some((p) => Math.abs(p.T - T) <= 180 + 0.2 * rt.offs[i])) seen.add(u);
      }));
      const truth = check.routes.map((_, j) => j).filter((j) => [...seen].every((u) => check.routes[j].stops.includes(u)));
      if (!seen.size || truth.length !== 1) continue;
      st.conVerdad++;
      const lists = (u) => { const q = rd.m.get(P.ids[u]); return q ? q.est.map((x) => ({ line: normLine(x.linea), ruta: x.ruta, minutos: x.minutos })) : null; };
      const js = P.branchPick(check, b.line, b.ruta, m, lists);
      const pl = porLinea.get(b.line) || { bien: 0, mal: 0, nada: 0 }; porLinea.set(b.line, pl);
      if (!js.includes(truth[0])) {
        st.mal++; pl.mal++;
        malos.push(`${hh(r.t)} ${b.line} "${b.ruta}" en ${id} a ${m} min: posibles [${js}], verdad ${truth[0]} (sondas ${check.probes.map((p) => `${P.ids[p.stop]}+${Math.round(p.off / 60)}min→[${p.routes}]`).join(" ")}; visto en ${[...seen].map((u) => P.ids[u]).join(",")})`);
      } else if (js.length === 1) {
        st.bien++; pl.bien++;
        for (const p of check.probes) if (p.routes.includes(js[0])) {
          const x = (lists(p.stop) || []).filter((y) => y.line === b.line && exact(y.ruta) === exact(b.ruta)).map((y) => Number(y.minutos) * 60 - (m * 60 + p.off));
          if (x.length) resid.push(x.reduce((a, c) => (Math.abs(c) < Math.abs(a) ? c : a)));
        }
      } else {
        st.sinDecidir++; pl.nada++;
        const k = `${b.line} "${b.ruta}" en ${id}`; sinDecidir.set(k, (sinDecidir.get(k) || 0) + 1);
      }
    }
  }
}
resid.sort((a, b) => a - b);
const q = (f) => resid.length ? Math.round(resid[Math.floor(f * (resid.length - 1))]) : null;
console.log(JSON.stringify({ ...st, vueltas: rounds.length,
  diferenciaEnLaSonda: { p1: q(0.01), p5: q(0.05), p50: q(0.5), p95: q(0.95), p99: q(0.99) },
  porLinea: Object.fromEntries([...porLinea].sort((a, b) => (b[1].mal + b[1].nada) - (a[1].mal + a[1].nada)).slice(0, 15)),
  casosSinDecidir: [...sinDecidir].sort((a, b) => b[1] - a[1]).slice(0, 15),
  dudososPorLinea: Object.fromEntries([...dud].sort((a, b) => b[1].dudosos - a[1].dudosos)),
  noDecididosPorMinutos: { "0-9": mb[0], "10-19": mb[1], "20-29": mb[2], "30-39": mb[3], "40-45": mb[4] },
  noDecididos: [...nd].sort((a, b) => b[1] - a[1]).slice(0, 25),
  malos: detalle ? malos : malos.slice(0, 15) }, null, 1));
