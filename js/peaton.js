/* SPDX-License-Identifier: AGPL-3.0-only · © 2026 asergom · ver LICENSE y TERMINOS-ADICIONALES.md */
/* Próximo Vitrasa: rutas a pie con la red peatonal propia (data/peatonal.json).
   Sin servicios externos: la red se descarga una vez y la ruta se calcula en el propio dispositivo.
   Red: © colaboradores de OpenStreetMap, licencia ODbL. */
(function (root) {
  "use strict";

  const KLAT = 110540;                 // metros por grado de latitud (aprox.)
  const CELL = 0.002;                  // tamaño de celda del índice espacial, en grados (~200 m)
  const MAX_SNAP = 600;                // más lejos de una calle no se considera dentro de la red (m)
  // Al elegir la ruta, las pistas y sendas de tierra cuentan algo más largas de lo que son,
  // para preferir calles y aceras si el rodeo es pequeño. La distancia mostrada es la real.
  const FACTOR = [1, 1, 1.25, 1];     // por tipo: normal, escaleras, sin asfaltar, Vigo Vertical
  // Cuestas (v2 de peatonal.json): cada tramo lleva los metros de más que "cuesta" en cada sentido
  // (tools/relieve.py). El tiempo a pie se da en "metros equivalentes" (eq): los que se andarían en
  // llano a 4,5 km/h en el mismo tiempo. La distancia (dist) sigue siendo la real.

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function decodePolyline(str, out) {
    let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (let k = 0; k < 2; k++) {
        let b, shift = 0, res = 0;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
        const d = res & 1 ? ~(res >> 1) : res >> 1;
        if (k === 0) lat += d; else lng += d;
      }
      out.push(lat / 1e5, lng / 1e5);
    }
  }

  // Montículo binario de mínimos sobre (coste, nodo).
  function Heap(cap) {
    let keys = new Float64Array(cap), vals = new Int32Array(cap), n = 0;
    return {
      get size() { return n; },
      push(k, v) {
        if (n === keys.length) {
          const k2 = new Float64Array(n * 2); k2.set(keys); keys = k2;
          const v2 = new Int32Array(n * 2); v2.set(vals); vals = v2;
        }
        let i = n++;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (keys[p] <= k) break;
          keys[i] = keys[p]; vals[i] = vals[p]; i = p;
        }
        keys[i] = k; vals[i] = v;
      },
      pop() {
        const top = vals[0];
        const k = keys[--n], v = vals[n];
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && keys[c + 1] < keys[c]) c++;
          if (keys[c] >= k) break;
          keys[i] = keys[c]; vals[i] = vals[c]; i = c;
        }
        keys[i] = k; vals[i] = v;
        return top;
      },
    };
  }

  // vv (opcional): data/vigo-vertical.json. Cada rampa, escalera mecánica o ascensor se añade a la
  // red como un tramo entre dos puntos nuevos ("a", abajo, y "b", arriba), cada uno unido a los dos
  // extremos del tramo de calle en el que cae. Su coste depende de la hora: ver setVertical().
  function build(data, vv = null) {
    // Cruces
    let N = data.nodos.length / 2;
    let nlat = new Float64Array(N), nlon = new Float64Array(N);
    let la = 0, lo = 0;
    for (let i = 0; i < N; i++) {
      la += data.nodos[2 * i]; lo += data.nodos[2 * i + 1];
      nlat[i] = la / 1e5; nlon[i] = lo / 1e5;
    }
    // Tramos: extremos, longitud y forma completa (incluidos los extremos).
    const W = data.v >= 2 ? 6 : 4;
    let E = data.aristas.length / W;
    const E0 = E;                       // tramos de calle (los siguientes son de Vigo Vertical)
    let ea = new Int32Array(E), eb = new Int32Array(E), elen = new Float64Array(E), etype = new Uint8Array(E);
    let tab = new Float64Array(E), tba = new Float64Array(E);   // metros equivalentes a → b y b → a
    let eoff = new Int32Array(E + 1);
    const pts = [];
    for (let e = 0; e < E; e++) {
      const a = data.aristas[W * e], b = data.aristas[W * e + 1];
      ea[e] = a; eb[e] = b; elen[e] = data.aristas[W * e + 2] / 10; etype[e] = data.aristas[W * e + 3];
      tab[e] = elen[e] + (W === 6 ? data.aristas[W * e + 4] / 10 : 0);
      tba[e] = elen[e] + (W === 6 ? data.aristas[W * e + 5] / 10 : 0);
      eoff[e] = pts.length / 2;
      pts.push(nlat[a], nlon[a]);
      if (data.formas[e]) decodePolyline(data.formas[e], pts);
      pts.push(nlat[b], nlon[b]);
    }
    eoff[E] = pts.length / 2;
    let P = Float64Array.from(pts);

    // Índice espacial: qué tramos pasan por cada celda.
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    for (let i = 0; i < P.length; i += 2) {
      if (P[i] < minLat) minLat = P[i]; if (P[i] > maxLat) maxLat = P[i];
      if (P[i + 1] < minLon) minLon = P[i + 1]; if (P[i + 1] > maxLon) maxLon = P[i + 1];
    }
    const GW = Math.ceil((maxLon - minLon) / CELL) + 1, GH = Math.ceil((maxLat - minLat) / CELL) + 1;
    const cells = new Map();
    for (let e = 0; e < E; e++) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let p = eoff[e]; p < eoff[e + 1]; p++) {
        const cx = Math.floor((P[2 * p + 1] - minLon) / CELL), cy = Math.floor((P[2 * p] - minLat) / CELL);
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      }
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
        const k = cy * GW + cx;
        let l = cells.get(k);
        if (!l) cells.set(k, (l = []));
        l.push(e);
      }
    }

    // Punto de la red más cercano: tramo, posición a lo largo de él y distancia.
    function snap(lat, lon) {
      const kx = 111320 * Math.cos(lat * Math.PI / 180);
      const cx = Math.floor((lon - minLon) / CELL), cy = Math.floor((lat - minLat) / CELL);
      const ringM = CELL * Math.min(KLAT, kx);
      let best = null, bestD = Infinity;
      const seen = new Set();
      for (let r = 0; r < 6; r++) {
        if (best && bestD < (r - 1) * ringM) break;
        for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r || x < 0 || y < 0 || x >= GW || y >= GH) continue;
          const l = cells.get(y * GW + x);
          if (!l) continue;
          for (const e of l) {
            if (seen.has(e)) continue;
            seen.add(e);
            for (let p = eoff[e]; p < eoff[e + 1] - 1; p++) {
              const ax = (P[2 * p + 1] - lon) * kx, ay = (P[2 * p] - lat) * KLAT;
              const bx = (P[2 * p + 3] - lon) * kx, by = (P[2 * p + 2] - lat) * KLAT;
              const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
              const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
              const qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(qx, qy);
              if (d < bestD) { bestD = d; best = { e, p, t }; }
            }
          }
        }
      }
      if (!best || bestD > MAX_SNAP) return null;
      // Fracción recorrida del tramo según su forma, aplicada a la longitud real.
      const { e, p, t } = best;
      let along = 0, total = 0;
      for (let q = eoff[e]; q < eoff[e + 1] - 1; q++) {
        const s = haversine(P[2 * q], P[2 * q + 1], P[2 * q + 2], P[2 * q + 3]);
        if (q < p) along += s; else if (q === p) along += s * t;
        total += s;
      }
      const f = total ? along / total : 0;
      const slat = P[2 * p] + t * (P[2 * p + 2] - P[2 * p]), slon = P[2 * p + 1] + t * (P[2 * p + 3] - P[2 * p + 1]);
      // ta: del punto al cruce a (se recorre en sentido b → a); tb: del punto al cruce b.
      return { e, p, t, ll: [slat, slon], off: bestD, da: f * elen[e], db: (1 - f) * elen[e], ta: f * tba[e], tb: (1 - f) * tab[e] };
    }

    // ---------- Vigo Vertical ----------
    // Por cada elemento k: dos cruces nuevos (abajo y arriba), cuatro tramos que los unen a los
    // extremos de su tramo de calle (partido en dos) y el tramo del propio elemento.
    const vEls = vv ? vv.elementos : [];
    const K = vEls.length, VE = new Int32Array(K).fill(-1);   // tramo de cada elemento
    const vOn = new Map();   // tramo de calle → puntos nuevos que caen en él: [{ id, da, ll }]
    const emech = new Float64Array(2 * (E + 5 * K));            // metros equivalentes "sin andar" (cinta, ascensor): [2e] a→b, [2e+1] b→a
    if (K) {
      const ext = [];            // [a, b, len, tipo, ab, ba, coords]
      const nodes = [];
      vEls.forEach((el, k) => {
        const sa = snap(el.a[0], el.a[1]), sb = snap(el.b[0], el.b[1]);
        if (!sa || !sb) return;
        const ends = [[sa, el.a], [sb, el.b]].map(([sn, ll]) => {
          const id = N + nodes.length;
          nodes.push(sn.ll);
          if (!vOn.has(sn.e)) vOn.set(sn.e, []);
          vOn.get(sn.e).push({ id, da: sn.da, ll: sn.ll });
          const e = sn.e, f = elen[e] ? sn.da / elen[e] : 0;
          // Del cruce a del tramo al punto nuevo, y del punto nuevo al cruce b.
          ext.push([ea[e], id, sn.da, etype[e], f * tab[e], f * tba[e], partial(sn, true).reverse()]);
          ext.push([id, eb[e], sn.db, etype[e], (1 - f) * tab[e], (1 - f) * tba[e], partial(sn, false)]);
          return id;
        });
        const len = el.wa + (el.L || 0) + el.wb;
        VE[k] = E + ext.length;
        ext.push([ends[0], ends[1], Math.max(len, 1), 3, Infinity, Infinity, [nodes[ends[0] - N], el.ka, el.kb, nodes[ends[1] - N]]]);
      });
      const N2 = N + nodes.length, E2 = E + ext.length;
      const grow = (A, n) => { const B = new A.constructor(n); B.set(A); return B; };
      nlat = grow(nlat, N2); nlon = grow(nlon, N2);
      nodes.forEach((ll, i) => { nlat[N + i] = ll[0]; nlon[N + i] = ll[1]; });
      ea = grow(ea, E2); eb = grow(eb, E2); elen = grow(elen, E2); etype = grow(etype, E2);
      tab = grow(tab, E2); tba = grow(tba, E2);
      const eoff2 = new Int32Array(E2 + 1); eoff2.set(eoff);
      const extra = [];
      let off = eoff[E];
      ext.forEach((x, i) => {
        const e = E + i;
        [ea[e], eb[e], elen[e], etype[e], tab[e], tba[e]] = x;
        eoff2[e] = off;
        for (const c of x[6]) extra.push(c[0], c[1]);
        off += x[6].length;
      });
      eoff2[E2] = off;
      const P2 = new Float64Array(P.length + extra.length); P2.set(P); P2.set(extra, P.length);
      P = P2; eoff = eoff2; N = N2; E = E2;
    }
    // Coste de cada elemento según esté o no funcionando. isOpen(el) → true / false.
    // Rampas y escaleras mecánicas: subiendo y en horario, la cinta (el.m); si no, andando por la
    // cuesta (el.wu / el.wd). Ascensores: en los dos sentidos solo en horario.
    function setVertical(isOpen) {
      vEls.forEach((el, k) => {
        const e = VE[k];
        if (e < 0) return;
        const open = !!isOpen(el), ends = el.wa + el.wb;
        let up, down, mu = 0, md = 0;
        if (el.t === "rampa" || el.t === "escalera") {
          up = ends + (open ? el.m : el.wu); down = ends + el.wd;
          if (open) mu = el.m;
        } else {
          up = down = open ? ends + el.m : Infinity;
          mu = md = open ? el.m : 0;
        }
        tab[e] = up; tba[e] = down; emech[2 * e] = mu; emech[2 * e + 1] = md;
      });
    }
    setVertical(() => true);

    // Adyacencia compacta: para cada cruce, sus tramos.
    const deg = new Int32Array(N + 1);
    for (let e = 0; e < E; e++) { deg[ea[e] + 1]++; deg[eb[e] + 1]++; }
    for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
    const adj = new Int32Array(2 * E), fill = deg.slice(0, N);
    for (let e = 0; e < E; e++) { adj[fill[ea[e]]++] = e; adj[fill[eb[e]]++] = e; }
    // Con rampas, la estimación de A* (línea recta) se divide por 2: la cinta va al doble de
    // la velocidad a pie, así que un tramo puede "costar" menos que su distancia.
    const HS = K ? 0.5 : 1;

    // Forma del tramo e desde el cruce "from", opcionalmente recortada.
    function edgeCoords(e, fromA) {
      const out = [];
      for (let q = eoff[e]; q < eoff[e + 1]; q++) out.push([P[2 * q], P[2 * q + 1]]);
      return fromA ? out : out.reverse();
    }
    // Trozo de forma entre el punto ajustado y uno de los extremos del tramo.
    function partial(s, toA) {
      const out = [s.ll];
      if (toA) for (let q = s.p; q >= eoff[s.e]; q--) out.push([P[2 * q], P[2 * q + 1]]);
      else for (let q = s.p + 1; q < eoff[s.e + 1]; q++) out.push([P[2 * q], P[2 * q + 1]]);
      return out;
    }

    const dist = new Float64Array(N).fill(Infinity);
    const prevE = new Int32Array(N);
    const touched = [];

    // Coste de recorrer el tramo e desde el cruce u: para elegir ruta (con FACTOR) y en tiempo (eq).
    const wOf = (e, u) => elen[e] * (FACTOR[etype[e]] - 1) + (ea[e] === u ? tab[e] : tba[e]);
    const tOf = (e, u) => (ea[e] === u ? tab[e] : tba[e]);
    // Mismo tramo: de s a g directamente.
    const sameT = (s, g) => (s.da <= g.da ? (g.da - s.da) / elen[s.e] * tab[s.e] : (s.da - g.da) / elen[s.e] * tba[s.e]) || 0;

    // Del punto s (en su tramo) a los cruces a y b del tramo y a los puntos de Vigo Vertical que caen
    // en él: [{ node, w (para elegir), t (tiempo), real, coords }]. toward: al revés, de cada uno a s.
    function endsOf(s, toward) {
      const e = s.e, fx = FACTOR[etype[e]] - 1;
      const along = (from, to) => (elen[e] ? (to >= from ? (to - from) / elen[e] * tab[e] : (from - to) / elen[e] * tba[e]) : 0);
      const one = (node, da, coords) => {
        const t = toward ? along(da, s.da) : along(s.da, da);
        return { node, t, w: t + Math.abs(da - s.da) * fx, real: Math.abs(da - s.da), coords };
      };
      const out = [one(ea[e], 0, partial(s, true)), one(eb[e], elen[e], partial(s, false))];
      for (const v of vOn.get(e) || []) out.push(one(v.id, v.da, [s.ll, v.ll]));
      if (toward) out.forEach((o) => o.coords.reverse());
      return out;
    }

    // Ruta más corta a pie entre dos puntos [lat, lon].
    function route(from, to) {
      const s = snap(from[0], from[1]), g = snap(to[0], to[1]);
      if (!s || !g) return null;
      for (const i of touched) dist[i] = Infinity;
      touched.length = 0;
      const tlat = g.ll[0], tlon = g.ll[1];
      const h = (i) => HS * haversine(nlat[i], nlon[i], tlat, tlon);
      const goals = new Map(endsOf(g, true).map((o) => [o.node, o]));   // cruce → camino hasta el destino
      const goal = new Map([...goals].map(([k, o]) => [k, o.w]));
      const seeds = new Map(endsOf(s, false).map((o) => [o.node, o]));
      const heap = Heap(1024);
      const relax = (i, d, viaE) => {
        if (d < dist[i]) {
          if (dist[i] === Infinity) touched.push(i);
          dist[i] = d; prevE[i] = viaE; heap.push(d + h(i), i);
        }
      };
      for (const o of seeds.values()) relax(o.node, o.w, -1);
      // Mismo tramo: ir directamente por él.
      let best = s.e === g.e ? sameT(s, g) + Math.abs(s.da - g.da) * (FACTOR[etype[s.e]] - 1) : Infinity, bestNode = -2;
      while (heap.size) {
        const u = heap.pop();
        const du = dist[u];
        if (du + h(u) >= best) break;
        if (goal.has(u) && du + goal.get(u) < best) { best = du + goal.get(u); bestNode = u; }
        for (let k = deg[u]; k < deg[u + 1]; k++) {
          const e = adj[k];
          const v = ea[e] === u ? eb[e] : ea[e];
          const w = wOf(e, u);
          if (w < Infinity) relax(v, du + w, e);
        }
      }
      if (best === Infinity) return null;

      // Reconstruir la geometría, la distancia real y el tiempo (eq).
      let coords, real, eq, mech = 0;
      const parts = [];   // elementos de Vigo Vertical usados, en orden: { el, up }
      // Trozos del camino en orden, para los pasos: { walk: true, real, eq } andando y
      // { el, up, used, real, eq } por cada elemento de Vigo Vertical que se usa (con la cinta o el
      // ascensor; si está parado y se sube andando, cuenta como andar).
      const segs = [];
      const addWalk = (r, t) => {
        const last = segs[segs.length - 1];
        if (last && last.walk) { last.real += r; last.eq += t; } else segs.push({ walk: true, real: r, eq: t });
      };
      if (bestNode === -2) {
        real = Math.abs(s.da - g.da);
        eq = sameT(s, g);
        addWalk(real, eq);
        // Origen y destino en el mismo tramo.
        const lo = s.da <= g.da ? s : g, hi = lo === s ? g : s;
        const mid = [];
        for (let q = lo.p + 1; q <= hi.p; q++) mid.push([P[2 * q], P[2 * q + 1]]);
        coords = [lo.ll, ...mid, hi.ll];
        if (lo !== s) coords.reverse();
      } else {
        const chain = [], path = [];
        let u = bestNode;
        real = 0; eq = 0;
        while (prevE[u] !== -1) {
          const e = prevE[u];
          const v = ea[e] === u ? eb[e] : ea[e];   // de v se llegó a u
          chain.push(edgeCoords(e, ea[e] === v));
          path.push([e, v]);
          real += elen[e];
          eq += tOf(e, v);
          if (etype[e] === 3) {
            const k = VE.indexOf(e), up = ea[e] === v;
            mech += emech[2 * e + (up ? 0 : 1)];
            parts.unshift({ el: vEls[k], up, used: emech[2 * e + (up ? 0 : 1)] > 0 });
          }
          u = v;
        }
        chain.reverse();
        path.reverse();
        const sd = seeds.get(u), gd = goals.get(bestNode);
        real += sd.real + gd.real;
        eq += sd.t + gd.t;
        addWalk(sd.real, sd.t);
        for (const [e, v] of path) {
          const t0 = tOf(e, v);
          if (etype[e] !== 3) { addWalk(elen[e], t0); continue; }
          const el = vEls[VE.indexOf(e)], up = ea[e] === v, m = emech[2 * e + (up ? 0 : 1)];
          if (!(m > 0)) { addWalk(elen[e], t0); continue; }
          // El tramo del elemento incluye lo que se anda hasta él (wa abajo, wb arriba).
          const w1 = up ? el.wa : el.wb, w2 = up ? el.wb : el.wa, wt = Math.max(0, t0 - m), ws = w1 + w2 || 1;
          addWalk(w1, wt * w1 / ws);
          segs.push({ el, up, used: true, real: el.L || 0, eq: m });
          addWalk(w2, wt * w2 / ws);
        }
        addWalk(gd.real, gd.t);
        coords = sd.coords.slice();
        for (const c of chain) coords.push(...c.slice(1));
        coords.push(...gd.coords.slice(1));
      }
      return {
        dist: real,              // metros por la red, de punto ajustado a punto ajustado
        eq,                      // lo mismo en tiempo: metros equivalentes en llano (cuestas incluidas)
        mech,                    // parte de eq en rampa, escalera mecánica o ascensor (no cuenta como andar)
        parts,                   // elementos de Vigo Vertical por los que pasa
        segs,                    // trozos en orden: andando y por cada elemento usado (para los pasos)
        coords,
        from: s.ll, to: g.ll,
        offFrom: s.off, offTo: g.off,   // metros desde el punto pedido hasta la calle más cercana
        explored: touched.length,
      };
    }

    // Distancias a pie desde un punto a todo lo que hay alrededor, hasta "max" metros equivalentes.
    // Devuelve una función que da los metros equivalentes (tiempo, con cuestas) hasta otro punto
    // (Infinity si queda más lejos); con real = true, [eq, metros reales del mismo camino].
    // toward = true: al revés, desde cada punto HASTA "from" (para las paradas de bajada: las cuestas
    // cuentan en el sentido en que se anda).
    // Se usa para ver qué paradas hay cerca del origen y del destino, y para los transbordos.
    // Incluye el tramo desde cada punto hasta la calle más cercana.
    function around(from, max, toward = false) {
      const s = snap(from[0], from[1]);
      if (!s) return () => Infinity;
      const d = new Map(), r = new Map(), mm = new Map();   // cruce → metros equivalentes / reales / sin andar
      const heap = Heap(256);
      const push = (i, v, m, x = 0) => { if (v <= max && v < (d.has(i) ? d.get(i) : Infinity)) { d.set(i, v); r.set(i, m); mm.set(i, x); heap.push(v, i); } };
      // Andar del punto a los cruces de su tramo, o (toward) de ellos al punto.
      for (const o of endsOf(s, toward)) push(o.node, o.t + s.off, o.real + s.off);
      while (heap.size) {
        const u = heap.pop();
        const du = d.get(u), ru = r.get(u), xu = mm.get(u);
        for (let k = deg[u]; k < deg[u + 1]; k++) {
          const e = adj[k];
          const v = ea[e] === u ? eb[e] : ea[e];
          const fwd = toward ? ea[e] === v : ea[e] === u;   // se anda en el sentido a → b del tramo
          const c = fwd ? tab[e] : tba[e];
          if (c < Infinity) push(v, du + c, ru + elen[e], xu + (etype[e] === 3 ? emech[2 * e + (fwd ? 0 : 1)] : 0));
        }
      }
      return (ll, snapped, real = false) => {
        const g = snapped || snap(ll[0], ll[1]);
        if (!g) return real ? [Infinity, Infinity] : Infinity;
        // De cada cruce del tramo de g (o punto de Vigo Vertical en él) hasta g (o, toward, al revés).
        let best = Infinity, bestR = Infinity, bestM = 0;
        for (const o of endsOf(g, !toward)) {
          if (d.has(o.node) && d.get(o.node) + o.t < best) { best = d.get(o.node) + o.t; bestR = r.get(o.node) + o.real; bestM = mm.get(o.node); }
        }
        if (g.e === s.e) {
          const same = toward ? sameT(g, s) : sameT(s, g);
          if (same + s.off < best) { best = same + s.off; bestR = Math.abs(s.da - g.da) + s.off; bestM = 0; }
        }
        return real ? [best + g.off, bestR + g.off, bestM] : best + g.off;
      };
    }

    return { route, snap, around, setVertical, vertical: vEls, horarios: vv ? vv.horarios : null, nodes: N, edges: E, fecha: data.fecha };
  }

  let pending = null;
  const api = {
    build,
    // Carga la red (y los elementos de Vigo Vertical, si están) una sola vez, solo cuando hace falta.
    load(url = "data/peatonal.json", vvUrl = "data/vigo-vertical.json") {
      const get = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
      if (!pending) pending = Promise.all([get(url), get(vvUrl).catch(() => null)]).then(([d, vv]) => build(d, vv))
        .catch((e) => { pending = null; throw e; });
      return pending;
    },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PV_PEATON = api;
})(this);
