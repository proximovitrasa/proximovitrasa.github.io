// SPDX-License-Identifier: AGPL-3.0-only
// Prueba de Cómo llegar con buses en vivo y ramales (tarea 75) con el registro de la API (rama
// prueba-concello, registro/<día>/api-*.jsonl.gz).
//
// Cada bus que pasa por una parada del registro se sigue hasta las paradas del registro que solo
// alcanzan algunos de sus recorridos posibles (ramales, viajes que rematan antes). Verdad: se le ve
// pasar por ellas con el MISMO letrero a la hora que toca (± 3 min + 20 %); otro letrero es otro
// bus. Se compara con lo que decide la web para "¿este bus en vivo me lleva de S a B?":
//   - antes: liveReaches (solo el letrero),
//   - ahora: liveReachesProbe (el letrero y, si no basta, las sondas: dónde sale el bus en la API
//     en esa misma vuelta de consultas, después de la separación).
// Lo que importa: 0 buses ofrecidos que no llegan ("no llega → yes") y los menos posibles perdidos
// ("llega → mixed/no": la web usa entonces el horario en vez del dato en vivo).
//
// Uso: TZ=Europe/Madrid node tools/probar_como_llegar.js api1.jsonl.gz [api2 …]
const fs = require("fs"), zlib = require("zlib"), path = require("path");
const ROOT = path.join(__dirname, "..");
const P = require(path.join(ROOT, "js/planificador.js")).build(require(path.join(ROOT, "data/viajes.json")));
const G = JSON.parse(fs.readFileSync(path.join(ROOT, "data/paradas.geojson")));
const nameOf = new Map(G.features.map((f) => [String(f.properties.id), f.properties.nombre]));
P.setStops(() => null, (id) => nameOf.get(id));
const exact = (s) => String(s || "").replace(/\s+/g, " ").trim();   // letrero tal cual: la verdad, solo con el mismo
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
const normLine = (c) => String(c).trim().replace(/[.\-]+$/, "").trim().replace(/^PSA(\d)/, "PSA $1");
const goes = (pt, b, a) => { const i = pt.p.indexOf(b); return i >= 0 && (pt.p.indexOf(a, i + 1) > i || (pt.c != null && P.pats[pt.c].p.indexOf(a, 1) > 0)); };
const hh = (T) => new Date(T * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

const rows = [];
for (const f of process.argv.slice(2)) for (const l of zlib.gunzipSync(fs.readFileSync(f)).toString("utf8").split("\n")) {
  if (!l.trim()) continue;
  const r = JSON.parse(l);
  if (!r.error && r.est) rows.push(r);
}
rows.sort((a, b) => a.t - b.t);
// Vueltas de consultas (cada ~6 min, todas las paradas)
const rounds = [];
for (const r of rows) {
  const cur = rounds[rounds.length - 1];
  if (!cur || r.t - cur.t1 > 120 || cur.m.has(r.id)) rounds.push({ t0: r.t, t1: r.t, m: new Map([[r.id, r]]) });
  else { cur.t1 = r.t; cur.m.set(r.id, r); }
}
const roundAt = (t) => rounds.find((x) => x.t0 <= t && t <= x.t1);

// Pasos de bus por parada: consultas a ≤ 7 min de un mismo bus juntas (con su última consulta).
const obs = new Map();
for (const r of rows) for (const x of r.est) {
  const m = Number(x.minutos); if (!isFinite(m) || m > 7) continue;
  const k = `${r.id}|${normLine(x.linea)}|${x.ruta}`;
  if (!obs.has(k)) obs.set(k, []);
  obs.get(k).push({ T: r.t + m * 60, m, t: r.t });
}
const passes = new Map();   // "stop|line" → [{ruta, T, m, t}]
for (const [k, os] of obs) {
  const [stop, line, ruta] = k.split("|");
  let cur = null;
  const flush = () => { if (cur) { const kk = `${stop}|${line}`; if (!passes.has(kk)) passes.set(kk, []); passes.get(kk).push(cur); } };
  for (const o of os.sort((a, b) => a.t - b.t)) {
    if (cur && o.t - cur.t <= 450 && (Math.abs(o.T - cur.T) <= 240 || Math.abs(o.m - cur.m) <= 1)) { cur.T = o.T; cur.m = o.m; cur.t = o.t; continue; }
    flush(); cur = { ruta, T: o.T, m: o.m, t: o.t };
  }
  flush();
}
const passesAt = (stop, line) => passes.get(`${stop}|${line}`) || [];

const regStops = [...new Set(rows.map((r) => r.id))].filter((id) => P.index.has(id));
const regSet = new Set(regStops);
const canProbe = (u) => regSet.has(P.ids[u]);   // en la web, cualquier parada; aquí solo las del registro
const travel = (s, b, line, dir, when) => {
  const out = [];
  for (const x of P.upcoming(s, when, 4500, 4500)) {
    const pt = P.pats[x.pat];
    if (pt.l !== line || pt.s !== dir || !goes(pt, s, b)) continue;
    const y = P.upcoming(b, new Date(when.getTime() - 4500e3), 4 * 3600, 0).find((z) => (z.pat === x.pat && z.trip === x.trip) || (pt.c === z.pat && z.trip >= x.trip));
    if (y) out.push(y.at - x.at);
  }
  return out;
};

const noList = [];
const tab = { antes: new Map(), ahora: new Map() };
const lost = { antes: new Map(), ahora: new Map() }, bad = { antes: [], ahora: [] };
const buses = new Set(), lostB = { antes: new Set(), ahora: new Set() };
for (const S of regStops) {
  const s = P.index.get(S);
  const lineDirs = new Map();
  for (const pt of P.pats) { const k = pt.p.indexOf(s); if (k >= 0 && (k < pt.p.length - 1 || pt.c != null)) lineDirs.set(`${pt.l}|${pt.s}`, [pt.l, pt.s]); }
  for (const [, [line, dir]] of lineDirs) {
    const ptsLD = P.pats.filter((pt) => pt.l === line && pt.s === dir && pt.p.includes(s));
    const branch = regStops.filter((B) => B !== S).map((B) => P.index.get(B)).filter((b) => {
      const r = ptsLD.map((pt) => goes(pt, s, b));
      const notLast = ptsLD.some((pt) => goes(pt, s, b) && pt.p.indexOf(b, pt.p.indexOf(s) + 1) < pt.p.length - 1);
      return r.some(Boolean) && !r.every(Boolean) && notLast;
    });
    if (!branch.length) continue;
    const dirHeads = new Set(P.pats.filter((pt) => pt.l === line && pt.s === dir).flatMap((pt) => (pt.h || []).map(norm)));
    const otherHeads = new Set(P.pats.filter((pt) => pt.l === line && pt.s !== dir).flatMap((pt) => (pt.h || []).map(norm)));
    for (const p of passesAt(S, line)) {
      if (!dirHeads.has(norm(p.ruta)) && otherHeads.has(norm(p.ruta))) continue;   // otro sentido
      const when = new Date(p.T * 1000);
      // Verdad estricta: avistamientos con el mismo letrero
      const hit = new Map();
      for (const b of branch) {
        const tr = travel(s, b, line, dir, when);
        if (!tr.length) continue;
        const lo = Math.min(...tr), hi = Math.max(...tr), tol = 180 + 0.2 * hi;
        hit.set(b, passesAt(P.ids[b], line).some((q) => exact(q.ruta) === exact(p.ruta) && q.T >= p.T + lo - tol && q.T <= p.T + hi + tol));
      }
      const seen = [...hit].filter(([, v]) => v).map(([b]) => b);
      if (!seen.length) continue;
      const rd = roundAt(p.t);
      const lists = (u) => { const q = rd && rd.m.get(P.ids[u]); return q ? q.est.map((x) => ({ line: normLine(x.linea), ruta: x.ruta, minutos: x.minutos })) : null; };
      for (const b of branch) {
        let truth;
        if (seen.includes(b)) truth = true;
        else if (seen.some((b2) => !ptsLD.some((pt) => goes(pt, s, b2) && goes(pt, s, b)))) truth = false;
        else continue;
        const leg = { line, dir, board: s, alight: b };
        const res = { antes: P.liveReaches(leg, p.ruta, when), ahora: P.liveReachesProbe(leg, p.ruta, when, p.m, lists, canProbe) };
        const busKey = `${line}|${S}|${p.T}`;
        if (truth) buses.add(busKey);
        for (const v of ["antes", "ahora"]) {
          const k = `${truth ? "llega" : "no llega"} → ${res[v]}`;
          tab[v].set(k, (tab[v].get(k) || 0) + 1);
          if (truth && res[v] !== "yes") {
            lostB[v].add(busKey);
            let why = res[v];
            if (v === "ahora" && res[v] === "mixed") {
              const c = P.branchCheck(s, line, dir, p.ruta, when, canProbe);
              why += !c ? ", sin recorridos distintos" : !c.probes.length ? ", ninguna sonda en el registro" : c.probes.some((q) => !lists(q.stop)) ? ", sonda sin consulta en esa vuelta" : c.probes.length ? ", sondas sin el bus" : ", sin sonda posible";
            }
            const kk = `${line} "${p.ruta}" (${why})`; lost[v].set(kk, (lost[v].get(kk) || 0) + 1);
          }
          if (truth && res[v] !== "yes" && v === "ahora") noList.push(`${hh(p.T)} ${line} "${p.ruta}" ${S}→${P.ids[b]} m=${p.m}`);
          if (!truth && res[v] === "yes") bad[v].push(`${hh(p.T)} ${line} "${p.ruta}" ${S}→${P.ids[b]}`);
        }
      }
    }
  }
}
const out = {};
for (const v of ["antes", "ahora"]) out[v] = {
  tabla: Object.fromEntries([...tab[v]].sort()),
  busesQueLlegan: buses.size, busesConAlgunaParadaPerdida: lostB[v].size,
  ofrecidosQueNoLlegan: bad[v].slice(0, 20), nOfrecidosQueNoLlegan: bad[v].length,
  perdidos: [...lost[v]].sort((a, b) => b[1] - a[1]).slice(0, 15),
};
out.llegaPeroNo = noList.slice(0, 20);
console.log(JSON.stringify(out, null, 1));
