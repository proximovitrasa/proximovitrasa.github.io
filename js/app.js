/* SPDX-License-Identifier: AGPL-3.0-only · © 2026 asergom · ver LICENSE y TERMINOS-ADICIONALES.md */
/* Próximo Vitrasa: mapa de paradas y próximos buses en Vigo. */
(() => {
  "use strict";
  // Inicio del día de servicio (mediodía − 12 h, como en GTFS): ver dayBase en planificador.js.
  const dayBase = (d) => new Date(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime() - 43200000);

  // ---------- Configuración ----------
  // Tiempos en vivo: API de datos abiertos del Concello de Vigo.
  // Si el navegador la bloquea (CORS), se puede poner aquí la URL de un proxy
  // definiendo window.PV_API_URL antes de cargar este script.
  const API_URL = window.PV_API_URL || "https://datos.vigo.org/vci_api_app/api2.jsp";
  const INFOBUS_URL = (id) => `https://infobus.vitrasa.es:8002/Default.aspx?parada=${encodeURIComponent(id)}`;
  const REFRESH_MS = 30000;
  const NEAR_COUNT = 15;
  const FAV_KEY = "pv:favoritas";
  const FAV_KEY2 = "pv:favoritas2";
  const VIGO = [42.2286, -8.7226];

  // ---------- Idioma ----------
  const I18N = window.PV_I18N;
  const LANG_KEY = "pv:idioma";
  function pickLang() {
    try { const saved = localStorage.getItem(LANG_KEY); if (saved && I18N.dict[saved]) return saved; } catch { /* sin almacenamiento */ }
    // Sin idioma elegido, gallego (57, decisión del usuario 31/10); se cambia con la bandera del mapa o en Más.
    return "gl";
  }
  let lang = pickLang();
  function t(key, params = {}) {
    const str = (I18N.dict[lang] && I18N.dict[lang][key]) || I18N.dict.es[key] || key;
    return str
      .replace(/\{(\w+)\} (min|Min\.)/g, (m, k, u) => (params[k] != null ? hMin(params[k], u) : m))
      .replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : ""));
  }
  // Minutos para leer: hasta 59 "45 min"; desde 60 "1 h 10 min" (o "2 h" si son horas justas).
  function hMin(n, unit = t("min")) {
    const v = Math.round(Number(n));
    if (!isFinite(v) || v < 60) return `${n} ${unit}`;
    return v % 60 ? `${Math.floor(v / 60)} h ${v % 60} ${unit}` : `${v / 60} h`;
  }
  // Lo mismo con el número grande (cifras en <b>, unidades en <span>).
  function etaNum(m) {
    m = Math.round(m);
    if (m < 60) return `<b>${m}</b><span>${esc(t("min"))}</span>`;
    return `<b>${Math.floor(m / 60)}</b><span>h</span>${m % 60 ? ` <b>${m % 60}</b><span>${esc(t("min"))}</span>` : ""}`;
  }
  const flagSvg = (code) => I18N.langs.find((l) => l.code === code).flag;

  // ---------- Utilidades ----------
  const panel = document.getElementById("panel");
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  // Nombre de la web (antes ProximoVitrasa; cambiado a "Vigo Bus" por el usuario el 30/10).
  const APP_NAME = "Vigo Bus";
  const isDesktop = () => matchMedia("(min-width: 860px)").matches;
  const canHover = matchMedia("(hover: hover)").matches;

  function haversine(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function fmtDist(m) {
    if (m < 1000) return `${Math.round(m / 10) * 10} m`;
    return `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(m / 1000)} km`;
  }
  const walkMin = (m) => Math.max(1, Math.round(m / 75)); // ~4,5 km/h

  const LOWER = new Set(["por", "de", "do", "da", "dos", "das", "del", "e", "y", "o", "a", "en"]);
  // "Hasta <parada>" para los viajes con varios letreros (67): se enseña tal cual, sin titleCase.
  const UNTIL = new Set();
  const untilLabel = (name) => { const x = t("until_stop", { stop: name }); UNTIL.add(x); return x; };
  const headText = (h) => (UNTIL.has(h) ? h : titleCase(h));
  function titleCase(s) {
    return s.replace(/\s+/g, " ").trim().toLowerCase().split(" ")
      .map((w, i) => (i > 0 && LOWER.has(w)) ? w : w.replace(/^(\(?)(\p{L})/u, (_, p, c) => p + c.toUpperCase()))
      .join(" ");
  }

  // Polilínea codificada (algoritmo de Google, precisión 5).
  function decodePolyline(str) {
    const out = [];
    let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (let k = 0; k < 2; k++) {
        let b, shift = 0, res = 0;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
        const d = res & 1 ? ~(res >> 1) : res >> 1;
        if (k === 0) lat += d; else lng += d;
      }
      out.push([lat / 1e5, lng / 1e5]);
    }
    return out;
  }

  const normLine = (c) => String(c).trim().replace(/[.\-]+$/, "").trim().replace(/^PSA(\d)/, "PSA $1");

  // Chapa de línea con su color oficial (si se conoce).
  function lineStyle(code) {
    const l = lines && lines[code];
    return l ? ` style="--lc:${l.color};--lt:${l.texto}"` : "";
  }
  function lineChip(code, cls = "chip") {
    const tappable = lines && lines[code];
    const tag = tappable ? "button" : "i";
    const attrs = tappable ? ` type="button" data-line="${esc(code)}" aria-label="${esc(t("see_line", { code }))}"` : "";
    return `<${tag} class="${cls}"${attrs}${lineStyle(code)}>${esc(code)}</${tag}>`;
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  // ---------- Estado ----------
  let stops = [];                 // {id, name, key, ll:[lat,lon], marker}
  const byId = new Map();
  let favs = loadFavs();
  let me = null;                  // [lat, lon] del usuario
  let mode = "near";              // near | fav | search
  let current = null;             // parada abierta
  let refreshTimer = null;
  let fetchCtl = null;
  let qTimer = null;               // búsqueda pendiente mientras se escribe
  let reqSeq = 0;                 // descarta respuestas de peticiones antiguas
  let lines = null;               // data/lineas.json: recorrido y paradas de cada línea
  let lineRuta = null;            // destino de la fila de llegadas desde la que se abrió la línea
  let active = null;              // línea iluminada: { code, dir, stops, from, fromDir }
  let tripRouteOn = false;        // hay un viaje dibujado en "Cómo llegar"

  // Favoritas (5): paradas (con las líneas que se quieren ver, o todas), direcciones o sitios, y
  // casa y trabajo. Se guardan en este dispositivo; las de antes (una lista de paradas) se pasan solas.
  // { stops: [{ id, lines: null | [códigos] }], places: [{ ll, label, site? }], home, work,
  //   trips: [{ a, b, al, bl, key, lines }] }  (trayectos, 37: a/b = extremo en la dirección web,
  //   "" para "Mi ubicación"; al/bl = nombres; key = combinación de líneas de la opción o "walk")
  function loadFavs() {
    const empty = { stops: [], places: [], home: null, work: null, trips: [] };
    try {
      const v2 = JSON.parse(localStorage.getItem(FAV_KEY2));
      if (v2 && Array.isArray(v2.stops)) return { ...empty, ...v2 };
      const old = JSON.parse(localStorage.getItem(FAV_KEY));
      if (Array.isArray(old)) return { ...empty, stops: old.map((id) => ({ id: String(id), lines: null })) };
    } catch { /* sin almacenamiento o datos raros */ }
    return empty;
  }
  function saveFavs() {
    try {
      localStorage.setItem(FAV_KEY2, JSON.stringify(favs));
      localStorage.setItem(FAV_KEY, JSON.stringify(favs.stops.map((f) => f.id)));   // por si se vuelve a una versión anterior
    } catch { /* sin almacenamiento */ }
  }
  const favStop = (id) => favs.stops.find((f) => f.id === id);
  const placeKey = (p) => `${fmtLL(p.ll)}|${p.label}`;
  const favPlace = (p) => favs.places.find((f) => placeKey(f) === placeKey(p));
  const tripFavKey = (f) => `${f.a}|${f.b}|${f.key}`;

  // Buscadas recientemente (14): las últimas paradas, direcciones y sitios elegidos en el buscador o
  // en Desde/Hasta, para volver a ellos sin escribir. [{ id } | { ll, label, site? }], la última primero.
  const RECENT_KEY = "pv:recientes", RECENT_MAX = 8;
  let recents = [];
  try { const r = JSON.parse(localStorage.getItem(RECENT_KEY)); if (Array.isArray(r)) recents = r.filter((x) => x && (x.id || (x.ll && x.label))); } catch { /* sin almacenamiento */ }
  const recentKey = (r) => (r.id ? `s${r.id}` : placeKey(r));
  function saveRecents() { try { localStorage.setItem(RECENT_KEY, JSON.stringify(recents)); } catch { /* sin almacenamiento */ } }
  function addRecent(r) {
    const e = r.id ? { id: String(r.id) } : { ll: [Number(r.ll[0].toFixed(5)), Number(r.ll[1].toFixed(5))], label: r.label, ...(r.site ? { site: r.site } : {}) };
    recents = [e, ...recents.filter((x) => recentKey(x) !== recentKey(e))].slice(0, RECENT_MAX);
    saveRecents();
  }

  // ---------- Mapa ----------
  const map = L.map("map", { zoomControl: false, preferCanvas: true, attributionControl: true })
    .setView(VIGO, 14);
  map.attributionControl.setPrefix(false);
  if (isDesktop()) L.control.zoom({ position: "topleft" }).addTo(map);

  // Mapa base (33): OpenFreeMap (gratuito y sin clave), siempre Positron (claro), también con el
  // móvil en modo oscuro: Fiord apenas se veía (decisión del usuario, 27/10). Es vectorial: lo pinta
  // MapLibre debajo de Leaflet con su complemento oficial (vendor/maplibre), que se descarga aparte
  // para no retrasar la web. Todo lo demás del mapa sigue en Leaflet. Si el móvil no tiene WebGL, o OpenFreeMap no carga en BASE_TIMEOUT, se usa el mapa
  // de OpenStreetMap de siempre (exige la cabecera Referer).
  const BASE_TIMEOUT = 8000;
  // Mapa de fondo (58): claro (Positron, por defecto), oscuro (estilo "dark" de OpenFreeMap; si no
  // carga, "fiord") o satélite (ortofoto PNOA del IGN, gratis y sin claves). Se recuerda en el móvil.
  const LAYER_KEY = "pv:capa";
  const OFM = (n) => `https://tiles.openfreemap.org/styles/${n}`;
  let baseLayer = "light";
  try { baseLayer = ["light", "dark", "sat"].includes(localStorage.getItem(LAYER_KEY)) ? localStorage.getItem(LAYER_KEY) : "light"; } catch { /* sin almacenamiento */ }
  const OFM_STYLE = OFM(baseLayer === "dark" ? "dark" : "positron");
  const PNOA_ATTR = 'Ortofoto: <a href="https://pnoa.ign.es/">PNOA</a> cedido por © <a href="https://www.ign.es/">IGN</a>';
  let satLayer = null;
  function setBaseLayer(kind) {
    baseLayer = kind;
    try { localStorage.setItem(LAYER_KEY, kind); } catch { /* sin almacenamiento */ }
    const box = map.getContainer();
    box.classList.toggle("sat-base", kind === "sat");
    box.classList.toggle("dark-base", kind === "dark");
    if (kind === "sat") {
      if (!satLayer) satLayer = L.tileLayer("https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0&format=image/jpeg&layer=OI.OrthoimageCoverage&style=default&tilematrixset=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}", {
        maxNativeZoom: 19, maxZoom: 20, attribution: PNOA_ATTR,
      });
      if (!map.hasLayer(satLayer)) satLayer.addTo(map);
      satLayer.bringToBack();
      if (glLayer && glLayer.getContainer && glLayer.getContainer()) glLayer.getContainer().style.visibility = "hidden";
      if (osmLayer && map.hasLayer(osmLayer)) map.removeLayer(osmLayer);
      return;
    }
    if (satLayer && map.hasLayer(satLayer)) map.removeLayer(satLayer);
    if (glLayer) {
      if (glLayer.getContainer && glLayer.getContainer()) glLayer.getContainer().style.visibility = "";
      const gl = glLayer.getMaplibreMap();
      glReady = false;
      gl.setStyle(OFM(kind === "dark" ? "dark" : "positron"));
      gl.once("styledata", () => { glReady = true; });
    } else if (osmLayer && !map.hasLayer(osmLayer)) osmLayer.addTo(map);
  }
  const OFM_ATTR = '<a href="https://openfreemap.org/">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a>, datos de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  let osmLayer = null, glLayer = null, glReady = false;
  function useOSM() {
    if (glLayer) { map.removeLayer(glLayer); glLayer = null; }
    map.getContainer().classList.remove("gl-base");
    if (!osmLayer) osmLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, referrerPolicy: "strict-origin-when-cross-origin",
      attribution: '© <a href="https://www.openstreetmap.org/copyright">Colaboradores de OpenStreetMap</a>',
    });
    if (!map.hasLayer(osmLayer) && baseLayer !== "sat") osmLayer.addTo(map);
  }
  function hasWebGL() {
    try { const c = document.createElement("canvas"); return !!(window.WebGL2RenderingContext && c.getContext("webgl2")) || !!c.getContext("webgl"); }
    catch { return false; }
  }
  const loadScript = (src) => new Promise((ok, ko) => {
    const el = document.createElement("script");
    el.src = src; el.onload = ok; el.onerror = ko;
    document.head.appendChild(el);
  });
  async function startBase() {
    try { localStorage.removeItem("pv:mapa"); } catch { /* del interruptor de prueba del 27/10 */ }
    if (!hasWebGL()) { useOSM(); return; }
    const timer = setTimeout(() => { if (!glReady) useOSM(); }, BASE_TIMEOUT);
    try {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = "vendor/maplibre/maplibre-gl.css";
      document.head.appendChild(css);
      await loadScript("vendor/maplibre/maplibre-gl.js");
      await loadScript("vendor/maplibre/leaflet-maplibre-gl.js");
      if (osmLayer && map.hasLayer(osmLayer)) { clearTimeout(timer); return; }   // ya se pasó a OpenStreetMap
      glLayer = L.maplibreGL({ style: OFM_STYLE, attributionControl: { customAttribution: OFM_ATTR } }).addTo(map);
      const gl = glLayer.getMaplibreMap();
      gl.once("load", () => {
        glReady = true;
        clearTimeout(timer);
        map.getContainer().classList.add("gl-base");
      });
      // Sin el estilo (OpenFreeMap caído o sin red), a OpenStreetMap; los fallos sueltos de una
      // tesela una vez cargado el mapa no cambian nada.
      gl.on("error", () => {
        // Sin el estilo oscuro de OpenFreeMap, su otro estilo oscuro ("fiord").
        if (baseLayer === "dark" && !glReady && !gl._pvFiord) { gl._pvFiord = true; gl.setStyle(OFM("fiord")); return; }
        if (!glReady) { clearTimeout(timer); useOSM(); }
      });
      if (baseLayer === "sat") setBaseLayer("sat");
    } catch {
      clearTimeout(timer);
      useOSM();
    }
  }
  startBase();
  map.attributionControl.addAttribution('Portales: <a href="https://datos.vigo.org/">Concello de Vigo</a>, <a href="https://www.sedecatastro.gob.es/">D. G. del Catastro</a>');
  map.attributionControl.addAttribution('Relieve: <a href="https://www.ign.es/">© IGN</a>');

  // Abierta como archivo (file://) no hay web de origen y OpenStreetMap bloquea el mapa.
  if (location.protocol === "file:") {
    setTimeout(() => toast(t("file_warning")), 800);
  }

  const css = getComputedStyle(document.documentElement);
  const RED = css.getPropertyValue("--bus").trim() || "#D3202F";
  const INK = css.getPropertyValue("--ink").trim() || "#13222C";
  const renderer = L.canvas({ padding: 0.3, tolerance: 6 });

  // Icono de parada (señal con un autobús). Rojo normal, azul ría en favoritas
  // y, con una línea elegida, del color oficial de esa línea.
  // La sombra va dentro del SVG (antes era un drop-shadow de CSS, que se recalculaba en cada
  // fotograma al mover el mapa): 1 px hacia abajo y 2 px de difuminado, medidos en píxeles de pantalla.
  const STOP_PAD = 3;   // margen alrededor del icono para que la sombra no se corte
  const stopSvg = (bg, fg, size) => { const u = 32 / size; return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-STOP_PAD} ${-STOP_PAD} ${32 + 2 * STOP_PAD} ${32 + 2 * STOP_PAD}"><defs><filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="${u.toFixed(2)}" stdDeviation="${u.toFixed(2)}" flood-color="#13222C" flood-opacity=".45"/></filter></defs><rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="${bg}" stroke="#fff" stroke-width="2.5" filter="url(#sh)"/><g fill="${fg}"><circle cx="8.6" cy="9.6" r="2.6"/><rect x="7.8" y="11.5" width="1.6" height="14.5" rx=".8"/><rect x="13" y="9.5" width="12.5" height="13.5" rx="2.6"/><rect x="14.4" y="22" width="2.6" height="3.6" rx=".9"/><rect x="21.5" y="22" width="2.6" height="3.6" rx=".9"/></g><rect x="15" y="11.5" width="8.5" height="5.6" rx="1.2" fill="${bg}"/></svg>`; };
  const sizeFor = (z) => (z <= 12 ? 12 : z === 13 ? 16 : z === 14 ? 20 : z === 15 ? 26 : 30);
  const iconCache = new Map();
  function iconFor(s, z) {
    let bg = "#D3202F", fg = "#FFFFFF";
    const l = active && lines && lines[active.code];
    if (l && active.stops.has(s.id)) { bg = l.color; fg = l.texto; }
    else if (favStop(s.id)) bg = "#13222C";
    const size = sizeFor(z) + (l && active.stops.has(s.id) ? 4 : 0), k = `${bg}|${fg}|${size}`;
    if (!iconCache.has(k)) {
      const full = Math.round(size * (32 + 2 * STOP_PAD) / 32);
      const icon = L.icon({
        iconUrl: `data:image/svg+xml,${encodeURIComponent(stopSvg(bg, fg, size))}`,
        iconSize: [full, full], iconAnchor: [full / 2, full / 2], className: "stop-icon",
      });
      icon.key = k;
      iconCache.set(k, icon);
    }
    return iconCache.get(k);
  }

  // ---------- Paradas en el mapa: solo las que caen en pantalla ----------
  // Cada parada tiene su marcador (se crea la primera vez que entra en pantalla), pero solo
  // están en el mapa las de la vista actual con un margen. El aspecto (icono, transparencia
  // con una línea abierta, orden) se aplica al añadirlas y, después, solo a las que están.
  const STOP_MARGIN = 0.35;   // margen alrededor de la pantalla, en fracción de su tamaño
  let shownStops = new Set();
  function stopMarker(s) {
    if (!s.marker) {
      s.marker = L.marker(s.ll, { icon: iconFor(s, map.getZoom()), keyboard: false, alt: s.name })
        .on("click", () => stopClick(s));
      if (canHover) s.marker.bindTooltip(() => `${esc(s.name)} (${esc(s.id)})`, { direction: "top", offset: [0, -6] });
      s.look = { icon: s.marker.options.icon.key, op: 1, z: 0 };
    }
    return s.marker;
  }
  function styleStop(s) {
    const m = stopMarker(s);
    const icon = iconFor(s, map.getZoom());
    const on = !active || active.stops.has(s.id);
    const op = on ? 1 : 0.12, z = active && on ? 500 : 0;
    if (s.look.icon !== icon.key) { m.setIcon(icon); s.look.icon = icon.key; if (s.look.op !== 1) m.setOpacity(s.look.op); }
    if (s.look.op !== op) { m.setOpacity(op); s.look.op = op; }
    if (s.look.z !== z) { m.setZIndexOffset(z); s.look.z = z; }
  }
  function syncStops() {
    if (!stops.length) return;
    // Alejado (zoom 14 o menos) caben cientos de paradas: van dibujadas en un lienzo (53). Con un
    // marcador por parada, alejar el mapa creaba y cambiaba más de mil elementos de golpe (tirones
    // de hasta medio segundo en un móvil). Las de cerca siguen siendo marcadores (se pueden tocar,
    // con su globo de ayuda en el ordenador).
    const low = map.getZoom() < STOP_DOM_ZOOM;
    const next = new Set();
    if (!low) {
      const b = map.getBounds().pad(STOP_MARGIN);
      for (const s of stops) if (b.contains(s.ll)) next.add(s);
    }
    shownStops.forEach((s) => { if (!next.has(s)) s.marker.remove(); });
    next.forEach((s) => { styleStop(s); if (!shownStops.has(s)) s.marker.addTo(map); });
    shownStops = next;
    drawStopsLow();
  }
  // Volver a pintar todas las paradas visibles (al abrir o cerrar una línea, por ejemplo).
  const restyleStops = () => { shownStops.forEach(styleStop); drawStopsLow(); };
  const refreshIcon = (s) => { if (shownStops.has(s)) styleStop(s); else drawStopsLow(); };

  // ---------- Paradas en un lienzo, con el mapa alejado ----------
  const STOP_DOM_ZOOM = 15;
  const STOP_CANVAS_PAD = 0.25;
  map.createPane("stopsLow").style.zIndex = 590;   // donde irían los marcadores (600), justo debajo
  map.getPane("stopsLow").style.pointerEvents = "none";
  const stopCanvas = L.DomUtil.create("canvas", "stop-canvas", map.getPane("stopsLow"));
  const stopImgs = new Map();   // clave del icono → imagen ya cargada
  let stopHits = [];            // { x, y, r, s } en coordenadas del contenedor
  const stopsLowHidden = () => tripRouteOn || !!active;   // con una línea alejada se ocultan (LINE_STOPS_ZOOM)
  // Cada icono se pasa una sola vez a un mapa de bits: dibujar el SVG directamente obliga a
  // calcular su sombra en cada parada y cada vez.
  function stopImg(icon) {
    let e = stopImgs.get(icon.key);
    if (!e) {
      e = { bmp: null };
      const im = new Image();
      im.onload = () => {
        const w = icon.options.iconSize[0], dpr = Math.min(2, window.devicePixelRatio || 1);
        const c = document.createElement("canvas");
        c.width = c.height = Math.ceil(w * dpr);
        c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
        e.bmp = c;
        drawStopsLow();
      };
      im.src = icon.options.iconUrl;
      stopImgs.set(icon.key, e);
    }
    return e.bmp;
  }
  function drawStopsLow() {
    const ctx = stopCanvas.getContext("2d");
    // El lienzo sobresale un cuarto de pantalla por cada lado, para que al arrastrar no se vean
    // huecos hasta que se suelta el mapa.
    const size = map.getSize(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const mx = Math.round(size.x * STOP_CANVAS_PAD), my = Math.round(size.y * STOP_CANVAS_PAD);
    const W = size.x + 2 * mx, Hh = size.y + 2 * my;
    if (stopCanvas.width !== W * dpr || stopCanvas.height !== Hh * dpr) {
      stopCanvas.width = W * dpr; stopCanvas.height = Hh * dpr;
      stopCanvas.style.width = `${W}px`; stopCanvas.style.height = `${Hh}px`;
    }
    L.DomUtil.setPosition(stopCanvas, map.containerPointToLayerPoint([-mx, -my]));
    stopCanvas.style.display = "";
    ctx.setTransform(dpr, 0, 0, dpr, mx * dpr, my * dpr);   // dibujo en coordenadas del contenedor
    ctx.clearRect(-mx, -my, W, Hh);
    stopHits = [];
    const z = map.getZoom();
    if (!stops.length || z >= STOP_DOM_ZOOM || stopsLowHidden()) return;
    const b = map.getBounds().pad(STOP_CANVAS_PAD + 0.05);
    const later = [];   // favoritas encima
    for (const s of stops) {
      if (!b.contains(s.ll)) continue;
      const icon = iconFor(s, z);
      (favStop(s.id) ? later : stopHits).push({ s, icon });
    }
    const all = stopHits.concat(later);
    stopHits = [];
    for (const { s, icon } of all) {
      const p = map.latLngToContainerPoint(s.ll), w = icon.options.iconSize[0];
      const im = stopImg(icon);
      if (im) ctx.drawImage(im, p.x - w / 2, p.y - w / 2, w, w);
      stopHits.push({ x: p.x, y: p.y, r: sizeFor(z) / 2 + 4, s });
    }
  }
  map.on("zoomstart", () => { stopCanvas.style.display = "none"; });
  // Parada dibujada bajo un punto del mapa (la de encima si se solapan).
  function stopAt(cp) {
    for (let i = stopHits.length - 1; i >= 0; i--) {
      const h = stopHits[i];
      if (Math.abs(cp.x - h.x) <= h.r && Math.abs(cp.y - h.y) <= h.r) return h.s;
    }
    return null;
  }
  const stopClick = (s) => { if (tripOpen()) tripPickStop(s); else navigate(s.id, { replace: !!current }); };
  // Va antes que los demás toques del mapa: si se toca una parada dibujada, se abre y nada más.
  map.on("click", (e) => {
    if (map.getZoom() >= STOP_DOM_ZOOM || !stopHits.length) return;
    const s = stopAt(e.containerPoint);
    if (!s) return;
    e.originalEvent._stopHit = true;
    stopClick(s);
  });
  if (canHover) {
    map.on("mousemove", (e) => {
      if (map.getZoom() >= STOP_DOM_ZOOM) return;
      const s = stopAt(e.containerPoint);
      map.getContainer().classList.toggle("on-stop", !!s);
      map.getContainer().title = s ? `${s.name} (${s.id})` : "";
    });
  }
  const lineGroup = L.layerGroup().addTo(map);

  const selRing = L.circleMarker(VIGO, { renderer, radius: 22, weight: 3, color: RED, fill: false, interactive: false });
  let meMarker = null;

  // Con una línea elegida y el mapa alejado, las paradas se ocultan para que se vea bien el recorrido.
  const LINE_STOPS_ZOOM = 15;
  function updateStopVisibility() {
    // Con una línea abierta, las paradas se ocultan al alejar. En "Cómo llegar", con un viaje
    // dibujado, solo se ven las paradas de ese viaje (las dibuja drawTrip con el color de su línea).
    map.getContainer().classList.toggle("hide-stops", !!active && map.getZoom() < LINE_STOPS_ZOOM);
    map.getContainer().classList.toggle("trip-stops", tripRouteOn);
    drawStopsLow();
    drawNums();   // los números de portal se ocultan con una línea o un viaje dibujados
  }

  map.on("zoomend", () => {
    updateStopVisibility();
    const z = map.getZoom();
    syncStops();   // también cambia el icono de las visibles; las demás, al entrar en pantalla
    selRing.setRadius(sizeFor(z) / 2 + 7);
  });
  map.on("moveend", () => {
    syncStops(); if (mode === "near" && !me && !current && !active) renderNear(); });

  // Centra un punto en la zona del mapa que no tapa el panel.
  function focusOn(ll, zoom) {
    const z = zoom != null ? zoom : Math.max(map.getZoom(), 16);
    const p = map.project(ll, z);
    const panel = $("#panel");
    // En móvil se usa la altura final del panel, no la de mitad de animación.
    const st = panel.dataset.state;
    const h = st === "full" ? innerHeight - 56 : st === "stop" ? innerHeight * 0.64 : st === "min" ? 92 : Math.max(260, innerHeight * 0.46);
    const shift = isDesktop() ? L.point(-panel.getBoundingClientRect().right / 2, 0) : L.point(0, h / 2);
    map.setView(map.unproject(p.add(shift), z), z, { animate: true });
  }

  // ---------- Datos ----------
  fetch("data/paradas.geojson")
    .then((r) => r.json())
    .then((gj) => {
      stops = gj.features.map((f) => {
        const [lon, lat] = f.geometry.coordinates;
        const s = { id: f.properties.id, name: f.properties.nombre, lines: f.properties.lineas || [], ll: [lat, lon] };
        s.key = norm(`${s.name} ${s.id}`);
        byId.set(s.id, s);
        return s;
      });
      // Encuadre inicial: el centro de Vigo, donde está la mayoría de paradas.
      map.setView(VIGO, 14);
      syncStops();
      route();
    })
    .catch(() => {
      $("#list-note").textContent = t("stops_error");
    });

  const linesReady = fetch("data/lineas.json")
    .then((r) => r.json())
    .then((d) => {
      lines = d;
      // Con las líneas ya cargadas: abrir un enlace #linea/… o dar color a las chapas visibles.
      if (location.hash.startsWith("#linea/")) route();
      else if (current) $("#stop-lines").innerHTML = current.lines.map((l) => lineChip(l)).join("");
      else if (panel.dataset.view === "place" && location.hash.startsWith("#dir/")) showPlace(location.hash.slice(5));   // chapas con su color
      else render();
    })
    .catch(() => { lines = {}; })
    .then(() => lines);

  // ---------- Lista ----------
  function stopItem(s, extra) {
    const li = document.createElement("li");
    li.innerHTML = `<button type="button" data-id="${esc(s.id)}">
      <span class="name">${extra.nameHtml || esc(s.name)}</span>
      <span class="sub">${esc(t("stop_n", { id: s.id }))}${extra.sub ? ` · ${esc(extra.sub)}` : ""}</span>
      ${s.lines.length && !extra.noLines ? `<span class="lines">${s.lines.map((l) => `<i${lineStyle(l)}>${esc(l)}</i>`).join("")}</span>` : ""}
      ${extra.dist != null ? `<span class="dist">${fmtDist(extra.dist)}</span>` : ""}
    </button>`;
    return li;
  }

  function fillList(items, note) {
    const ul = $("#list");
    ul.replaceChildren(...items);
    const n = $("#list-note");
    if (note instanceof Node) n.replaceChildren(note); else n.textContent = note || "";
  }

  function nearest(origin, n) {
    return stops.map((s) => ({ s, d: haversine(origin, s.ll) }))
      .sort((a, b) => a.d - b.d).slice(0, n);
  }

  // Filas del buscador y de las paradas cercanas como en el mockup (rediseño, fase 2): un cuadro
  // con el icono (parada, línea, sitio o dirección), el nombre, una línea gris y la distancia.
  // Icono de parada (elegido por el usuario el 30/10): poste con señal redonda y autobús de frente.
  const STOP_TILE = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="8" fill="#D3202F"/><g fill="#fff"><circle cx="8.6" cy="9.6" r="2.6"/><rect x="7.8" y="11.5" width="1.6" height="14.5" rx=".8"/><rect x="13" y="9.5" width="12.5" height="13.5" rx="2.6"/><rect x="14.4" y="22" width="2.6" height="3.6" rx=".9"/><rect x="21.5" y="22" width="2.6" height="3.6" rx=".9"/></g><rect x="15" y="11.5" width="8.5" height="5.6" rx="1.2" fill="#D3202F"/></svg>';
  const PIN_TILE = '<svg class="ln" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21c-5-6-7-9.5-7-12a7 7 0 0 1 14 0c0 2.5-2 6-7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>';
  const SITE_TILE = {
    estacion: '<svg class="ln" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="13" rx="3"/><path d="M4 11h16M8 21l2-4M16 21l-2-4"/></svg>',
    aeropuerto: '<svg class="ln" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 3.5a1.5 1.5 0 0 1 3 0V9l7 4v2l-7-2v5l2 1.5V21l-3.5-1-3.5 1v-1.5l2-1.5v-5l-7 2v-2l7-4z"/></svg>',
    hospital: '<svg class="ln" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
    otro: '<svg class="ln" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21c-5-6-7-9.5-7-12a7 7 0 0 1 14 0c0 2.5-2 6-7 12z"/><path d="M12 6.5l.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z"/></svg>',
  };
  SITE_TILE.salud = SITE_TILE.hospital;
  const siteTile = (type) => SITE_TILE[type] || SITE_TILE.otro;
  const nLines = (n) => (n === 1 ? t("n_line1") : t("n_lines", { n }));
  function resRow(attrs, tile, nameHtml, sub, dist) {
    const li = document.createElement("li");
    li.innerHTML = `<button type="button" class="res-row" ${attrs}>
      <span class="tile">${tile}</span>
      <span class="txt"><span class="name">${nameHtml}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</span>
      ${dist != null ? `<span class="dist">${fmtDist(dist)}</span>` : ""}
    </button>`;
    return li;
  }
  function resStop(s, nameHtml) {
    return resRow(`data-id="${esc(s.id)}"`, STOP_TILE, nameHtml || esc(s.name),
      esc(`${t("stop_n", { id: s.id })} · ${nLines(s.lines.length)}`), me ? haversine(me, s.ll) : null);
  }
  function secHead(text, extra = "") {
    const li = document.createElement("li");
    li.className = "sec-head";
    li.innerHTML = `<span>${esc(text)}</span>${extra}`;
    return li;
  }

  // "Qué sale ya cerca de mí" (22): con la ubicación, primero los próximos buses de las paradas a
  // menos de 600 m, mezclados por minutos (sin los que pasan antes de poder llegar andando).
  const NEAR_DEP_M = 600, NEAR_DEP_MAX = 8;
  let nearTimer = null;
  // Inicio como en el mockup (3): "Sale ya cerca de ti" con un enlace a las paradas cercanas, que
  // van debajo en la misma hoja. Sin tu ubicación: las paradas de la zona del mapa.
  function renderNear() {
    if (!stops.length) return;
    clearTimeout(nearTimer);
    if (me) {
      const near = nearest(me, NEAR_COUNT);
      const dep = document.createElement("li");
      dep.className = "near-dep";
      dep.innerHTML = `<div class="near-head"><h3>${esc(t("near_dep"))}</h3><button type="button" class="near-more" data-near-more="1">${esc(t("near_stops"))}</button></div>
        <div class="near-dep-list"><p class="note">…</p></div>`;
      const head = secHead(t("near_stops"));
      head.id = "near-stops-head";
      fillList([dep, head, ...near.map(({ s }) => resStop(s))], "");
      refreshNearDep();
    } else {
      const c = map.getCenter();
      const top = document.createElement("li");
      top.className = "near-dep";
      top.innerHTML = `<div class="near-head"><h3>${esc(t("area_title"))}</h3><button type="button" class="near-more" data-use-loc="1">${esc(t("use_location"))}</button></div>`;
      fillList([top, ...nearest([c.lat, c.lng], NEAR_COUNT).map(({ s }) => resStop(s))], "");
    }
  }
  $("#list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-near-more], [data-use-loc]");
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.useLoc) { locate(); return; }
    // "Paradas cercanas": se abre la hoja entera y se baja hasta la lista.
    setPanel("full");
    setTimeout(() => {
      const h = $("#near-stops-head");
      if (h) $("#list").scrollTo({ top: h.offsetTop - $("#list").offsetTop, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }, 300);
  });


  function highlight(name, tokens) {
    // Subraya las coincidencias sin tener en cuenta tildes.
    const plain = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const ranges = [];
    tokens.forEach((t) => { const i = plain.indexOf(t); if (i >= 0) ranges.push([i, i + t.length]); });
    if (!ranges.length) return esc(name);
    ranges.sort((a, b) => b[0] - a[0]);
    const out = name;
    const parts = [];
    let end = out.length;
    ranges.forEach(([a, b]) => { if (b > end) return; parts.unshift(esc(out.slice(b, end))); parts.unshift(`<mark>${esc(out.slice(a, b))}</mark>`); end = a; });
    parts.unshift(esc(out.slice(0, end)));
    return parts.join("");
  }

  // Paradas que coinciden con lo escrito: por número de poste o por palabras del nombre (sin tildes).
  function matchStops(q) {
    const nq = norm(q);
    const tokens = nq.split(" ").filter(Boolean);
    if (/^\d+[a-z]?$/.test(nq)) {
      return stops.filter((s) => s.id.toLowerCase().startsWith(nq))
        .sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
    }
    const res = stops.filter((s) => tokens.every((t) => s.key.includes(t)));
    res.sort((a, b) => (a.key.startsWith(tokens[0]) ? 0 : 1) - (b.key.startsWith(tokens[0]) ? 0 : 1) || a.name.localeCompare(b.name, "es"));
    return res;
  }

  function renderSearch(q) {
    const nq = norm(q);
    const tokens = nq.split(" ").filter(Boolean);
    const res = matchStops(q);
    // Líneas: por código ("18" → 18A, 18B, 18H; "c3" → C3d, C3i) o por nombre ("hospital").
    const compact = nq.replace(/ /g, "");
    const lineRes = !lines ? [] : Object.keys(lines).filter((code) => {
      const c = norm(code).replace(/ /g, "");
      return c === compact || (compact.length >= 1 && c.startsWith(compact) && /\d|^[a-z]{1,3}$/.test(compact)) ||
        (tokens.length && tokens.every((tk) => norm(lines[code].nombre).includes(tk)) && compact.length >= 3);
    });
    const shown = res.slice(0, 60);
    // Direcciones (calle y número), a partir de 3 letras; el diccionario se descarga la primera vez.
    const addr = [];
    if (/\p{L}.*\p{L}.*\p{L}/u.test(q)) {
      if (!dirData) ensureDir().then(() => { if ($("#q").value.trim() === q && mode === "search") renderSearch(q); }).catch(() => {});
      else {
        const p = dirData.parse(q);
        const found = dirData.matchStreets(p.street, p.num ? 3 : 4);
        found.forEach((st) => addr.push(addrItem(st, p.num, tokens, true)));
        if (p.num && found[0]) dirData.numbersStarting(found[0], p.num, 3).forEach((n) => addr.push(addrItem(found[0], n, tokens, true)));
      }
    }
    // Sitios importantes, también a partir de 3 letras.
    let sites = [];
    if (/\p{L}.*\p{L}.*\p{L}/u.test(q)) {
      if (!sitesData) ensureSites().then(() => { if ($("#q").value.trim() === q && mode === "search") renderSearch(q); }).catch(() => {});
      else sites = matchSites(q);
    }
    // Como en el mockup (11): Paradas, Líneas, Sitios y Direcciones, cada grupo con su título.
    // Si hay otros grupos, solo las 5 primeras paradas y un botón para verlas todas.
    const others = lineRes.length || addr.length || sites.length;
    const few = others && !searchAllStops ? shown.slice(0, 5) : shown;
    const items = [];
    if (shown.length) {
      items.push(secHead(t("res_stops")), ...few.map((s) => resStop(s, highlight(s.name, tokens))));
      if (few.length < shown.length || res.length > shown.length) {
        const li = document.createElement("li");
        li.className = "see-all";
        li.innerHTML = few.length < shown.length ? `<button type="button" data-all-stops="1">${esc(t("see_all_stops", { n: res.length }))}</button>` : `<p class="note">${esc(t("many", { n: res.length }))}</p>`;
        items.push(li);
      }
    }
    if (lineRes.length) {
      items.push(secHead(t("res_lines")));
      lineRes.forEach((code) => {
        const [d0, d1] = lines[code].sentidos;
        items.push(resRow(`data-line="${esc(code)}"`, `<span class="badge"${lineStyle(code)}>${esc(code)}</span>`,
          highlight(d0 ? d0.destino : lines[code].nombre, tokens), d1 ? highlight(d1.destino, tokens) : ""));
      });
    }
    if (sites.length) items.push(secHead(t("res_sites")), ...sites.map((x) => siteItem(x, tokens)));
    if (addr.length) items.push(secHead(t("res_addr")), ...addr);
    fillList(items, res.length || others ? "" : t("no_results", { q }));
  }
  let searchAllStops = false;
  $("#list").addEventListener("click", (e) => {
    if (!e.target.closest("[data-all-stops]")) return;
    e.stopPropagation();
    searchAllStops = true;
    render();
  });


  // ---------- Sitios importantes (6) ----------
  // De OpenStreetMap (data/sitios.json, tools/actualizar_sitios.py): solo para buscarlos por su nombre
  // (o por sus otros nombres), sin dibujarlos en el mapa. Se descarga al empezar a escribir.
  let sitesData = null, sitesPending = null;
  function ensureSites() {
    if (sitesData) return Promise.resolve(sitesData);
    if (!sitesPending) {
      sitesPending = fetch("data/sitios.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then((d) => (sitesData = d.sitios.map(([name, la, lo, ty, extra], i) => ({
          i, name, ll: [la / 1e5, lo / 1e5], type: d.tipos[ty], key: norm(name), alt: norm(extra || ""),
        }))))
        .catch((e) => { sitesPending = null; throw e; });
    }
    return sitesPending;
  }
  // Cada palabra escrita es el principio de alguna palabra del nombre (o de sus otros nombres).
  function matchSites(q, limit = 5) {
    if (!sitesData) return [];
    const tokens = norm(q).split(" ").filter(Boolean);
    if (!tokens.length) return [];
    const starts = (key, tk) => key.startsWith(tk) || key.includes(` ${tk}`);
    const out = [];
    for (const s of sitesData) {
      const inName = tokens.every((tk) => starts(s.key, tk));
      if (!inName && !tokens.every((tk) => starts(s.key, tk) || starts(s.alt, tk))) continue;
      out.push({ s, score: (inName ? 0 : 2) + (s.key.startsWith(tokens[0]) ? 0 : 1) });
    }
    out.sort((a, b) => a.score - b.score || (me ? haversine(me, a.s.ll) - haversine(me, b.s.ll) : 0) || a.s.name.localeCompare(b.s.name, "es"));
    return out.slice(0, limit).map((x) => x.s);
  }
  function siteItem(s, tokens) {
    return resRow(`data-site="${s.i}"`, siteTile(s.type), highlight(s.name, tokens), esc(t(`site_${s.type}`)), me ? haversine(me, s.ll) : null);
  }

  function lineItem(code, nameHtml) {
    const li = document.createElement("li");
    li.innerHTML = `<button type="button" data-line="${esc(code)}" class="line-row">
      <span class="badge"${lineStyle(code)}>${esc(code)}</span>
      <span class="name">${nameHtml || esc(lines[code].nombre)}</span>
    </button>`;
    return li;
  }
  function groupHead(text) {
    const li = document.createElement("li");
    li.className = "group-head";
    li.textContent = text;
    return li;
  }

  // Elementos de "Buscadas recientemente" (en el buscador y en Desde/Hasta).
  function recentItems(opts = {}) {
    const items = [];
    recents.forEach((r, k) => {
      if (r.id) {
        const s = byId.get(r.id);
        if (s) items.push(stopItem(s, { noLines: opts.noLines, dist: me ? haversine(me, s.ll) : null }));
        return;
      }
      const li = document.createElement("li");
      li.innerHTML = `<button type="button" data-recent="${k}">
        <span class="name">${esc(r.label)}</span>
        <span class="sub">${esc(r.site ? t(`site_${r.site}`) : t("fav_address"))}</span>
        ${me ? `<span class="dist">${fmtDist(haversine(me, r.ll))}</span>` : ""}
      </button>`;
      items.push(li);
    });
    if (!items.length) return [];
    const head = document.createElement("li");
    head.className = "group-head recent-head";
    head.innerHTML = `<span>${esc(t("recent_title"))}</span><button type="button" class="recent-clear" data-recent-clear="1">${esc(t("recent_clear"))}</button>`;
    return [head, ...items];
  }
  // Buscador en uso sin nada escrito: las buscadas recientemente o, si no hay, las paradas cercanas.
  function renderRecent() {
    const items = [];
    if (recents.length) {
      items.push(secHead(t("recent_title"), `<button type="button" class="recent-clear" data-recent-clear="1">${esc(t("recent_clear"))}</button>`));
      recents.forEach((r, k) => {
        if (r.id) { const s = byId.get(r.id); if (s) items.push(resStop(s)); return; }
        items.push(resRow(`data-recent="${k}"`, r.site ? siteTile(r.site) : PIN_TILE, esc(r.label), esc(r.site ? t(`site_${r.site}`) : t("fav_address")), me ? haversine(me, r.ll) : null));
      });
    } else {
      const c = map.getCenter();
      items.push(secHead(t(me ? "near_stops" : "area_title")), ...nearest(me || [c.lat, c.lng], NEAR_COUNT).map(({ s }) => resStop(s)));
    }
    fillList(items, "");
  }

  // Líneas como en el mockup (rediseño): buscador en la cabecera roja, filtros Todas / Cerca de
  // ti / Nocturnas y cada línea con sus dos destinos.
  let linesFilter = "all";
  const NEAR_LINES_M = 600;
  function renderLinesHead() {
    const box = $("#screen-extra");
    if (box.dataset.kind === "lines") return;   // no se rehace mientras se escribe
    box.dataset.kind = "lines";
    box.className = "screen-extra lines-head";
    box.innerHTML = `<label class="lines-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
      <input id="lines-q" type="search" autocomplete="off" spellcheck="false" placeholder="${esc(t("lines_ph"))}" aria-label="${esc(t("lines_ph"))}"></label>`;
  }
  function renderLines() {
    renderLinesHead();
    if (!lines) { fillList([], t("loading_lines")); return; }
    const all = Object.keys(lines).sort((a, b) => (parseInt(a.replace(/^\D+/, ""), 10) || 0) - (parseInt(b.replace(/^\D+/, ""), 10) || 0) || a.localeCompare(b));
    const q = norm(($("#lines-q") || {}).value || "").trim();
    let codes = all;
    if (linesFilter === "night") codes = codes.filter((c) => /^N\d/i.test(c));
    if (linesFilter === "near" && me) {
      const near = new Set();
      stops.forEach((s) => { if (haversine(me, s.ll) <= NEAR_LINES_M) s.lines.forEach((c) => near.add(c)); });
      codes = codes.filter((c) => near.has(c));
    } else if (linesFilter === "near" && meFar) codes = [];   // lejos de Vigo: ninguna cerca
    if (q) codes = codes.filter((c) => norm(c).startsWith(q) || lines[c].sentidos.some((d) => norm(d.destino).includes(q)));
    const chips = document.createElement("li");
    chips.className = "line-filters";
    chips.innerHTML = [["all", `${t("lines_all")} · ${all.length}`], ["near", t("lines_near")], ["night", t("lines_night")]]
      .map(([k, txt]) => `<button type="button" data-lfilter="${k}" aria-pressed="${linesFilter === k}">${esc(txt)}</button>`).join("");
    const items = codes.map((code) => {
      const li = document.createElement("li");
      const [d0, d1] = lines[code].sentidos;
      li.innerHTML = `<button type="button" data-line="${esc(code)}" class="line-row2">
        <span class="badge"${lineStyle(code)}>${esc(code)}</span>
        <span class="dests"><span class="name">${esc(d0 ? d0.destino : lines[code].nombre)}</span>${d1 ? `<span class="sub">${esc(d1.destino)}</span>` : ""}</span>
        ${CHEV_R}</button>`;
      return li;
    });
    fillList([chips, ...items], items.length ? "" : t(linesFilter === "near" && !me ? (meFar ? "geo_far" : "geo_needed") : "lines_none"));
  }
  $("#screen-extra").addEventListener("input", (e) => { if (e.target.id === "lines-q") renderLines(); });
  $("#list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-lfilter]");
    if (!b) return;
    e.stopPropagation();
    linesFilter = b.dataset.lfilter;
    if (linesFilter === "near" && !me) { getPosition(() => renderLines()); }
    renderLines();
  });

  const TABS = ["near", "fav", "lines"];
  function render() {
    const q = $("#q").value.trim();
    $("#q-clear").hidden = !q;
    if (q) { mode = "search"; renderSearch(q); syncSearchScreen(); return; }
    searchAllStops = false;
    if (document.activeElement === $("#q") && !location.hash) { mode = "recent"; renderRecent(); syncSearchScreen(); return; }
    if (mode === "search" || mode === "recent") mode = TABS.find((t) => $(`#tab-${t}`).getAttribute("aria-selected") === "true") || "near";
    if (mode === "fav") renderFav();
    else if (mode === "lines") renderLines();
    else renderNear();
    syncSearchScreen();
  }
  // Buscador en uso (mockup 11): cabecera roja con el buscador y "Cancelar", resultados en la hoja.
  function syncSearchScreen() {
    if (panel.dataset.view !== "home" || mode === "fav" || mode === "lines") return;
    const on = mode === "search" || mode === "recent";
    panel.dataset.screen = on ? "search" : "home";
    if (on && !isDesktop()) panel.dataset.state = "full";
  }

  function setTab(which) {
    // Cada lista tiene ahora su sitio en la barra de secciones.
    if (which === "fav" || which === "lines") { navigate(which === "fav" ? "favoritas" : "lineas"); return; }
    TABS.forEach((t) => $(`#tab-${t}`).setAttribute("aria-selected", t === which));
    mode = which;
    render();
  }

  // ---------- Ubicación ----------
  // Mi ubicación en tiempo real (66): con el permiso ya dado, el punto azul sigue tu posición
  // mientras la web está a la vista (sin mover el mapa); se para al ocultarla.
  let watchId = null, nearAt = null, meFar = false;
  const FAR_VIGO_M = 25000;
  const farFromVigo = (ll) => haversine(ll, VIGO) > FAR_VIGO_M;
  // Lejos de Vigo (más de 25 km del centro) la web solo vale para Vigo: tu posición no se guarda
  // en `me` (para todo lo demás es como si no hubiera ubicación) ni se dibuja el punto azul.
  function setMe(pos) {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    meFar = farFromVigo(ll);
    if (meFar) {
      me = null;
      if (meMarker) { meMarker.remove(); meMarker = null; }
      return ll;
    }
    me = ll;
    const icon = L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18] });
    if (meMarker) meMarker.setLatLng(me); else meMarker = L.marker(me, { icon, interactive: false, keyboard: false }).addTo(map);
    return ll;
  }
  function startWatch() {
    if (watchId != null || !("geolocation" in navigator) || document.hidden) return;
    watchId = navigator.geolocation.watchPosition((pos) => {
      const had = me;
      setMe(pos);
      if (!me) { if (had && panel.dataset.view === "home") { nearAt = null; render(); } return; }
      // En el inicio, las paradas y los buses cercanos se rehacen si te has movido más de 80 m.
      if (panel.dataset.view === "home" && mode === "near" && (!nearAt || haversine(nearAt, me) > 80)) { nearAt = me.slice(); render(); }
    }, () => { stopWatch(); }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  }
  function stopWatch() { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopWatch(); else if (me) startWatch(); });
  // Si ya se dio permiso otra vez, se empieza sin preguntar nada.
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: "geolocation" }).then((st) => { if (st.state === "granted") startWatch(); }).catch(() => {});
  }
  // onFar: qué hacer si estás lejos de Vigo (por defecto, avisar y no hacer nada más).
  function getPosition(onOk, onFar = () => toast(t("geo_far"))) {
    if (!("geolocation" in navigator)) { toast(t("geo_unsupported")); return; }
    const btn = $("#locate");
    btn.classList.add("busy");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.classList.remove("busy");
        const ll = setMe(pos);
        startWatch();
        if (me) onOk(me); else onFar(ll);
      },
      (err) => {
        btn.classList.remove("busy");
        toast(err.code === 1 ? t("geo_denied") : t("geo_error"));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  function locate() {
    // En "Cómo llegar" solo se centra el mapa en tu posición, sin salir de la vista.
    // Lejos de Vigo: se avisa y el mapa se queda donde está.
    if (tripOpen()) {
      getPosition((ll) => focusOn(ll, 16), () => toast(t("geo_far_trip")));
      return;
    }
    getPosition(() => {
        if (location.hash) navigate("");
        $("#q").value = "";
        setTab("near");
        focusOn(me, 16);
    });
  }

  // ---------- Navegación ----------
  // El estado vive en la dirección: "" inicio, "#5660" parada, "#linea/18A" línea, "#ir/A/B" cómo llegar.
  // Así el botón Atrás del móvil y los enlaces compartidos funcionan solos.
  function navigate(hash, { replace = false } = {}) {
    const url = hash ? `#${hash}` : location.pathname + location.search;
    if (replace || !hash) history.replaceState({ d: 0 }, "", url);
    else history.pushState({ d: ((history.state && history.state.d) || 0) + 1 }, "", url);
    route();
  }
  // ---------- Barra de secciones (rediseño, fase 1) ----------
  // Buscar = inicio y todo lo que se abre desde él (parada, línea, dirección, horarios); Favoritas,
  // Cómo llegar, Líneas y Más (información útil e idioma), cada una con su pantalla.
  let lineTab = "";   // sección de la barra desde la que se abrió la línea ("lineas" o la de siempre)
  function tabbarSection() {
    const v = panel.dataset.view;
    if (v === "line" && lineTab) return lineTab;
    if (v === "trip") return "ir";
    if (v === "info") return "info";
    if (v === "home" && mode === "fav") return "favoritas";
    if (v === "home" && mode === "lines") return "lineas";
    return "";
  }
  function updateTabbar() {
    const cur = tabbarSection();
    document.querySelectorAll("#tabbar [data-go]").forEach((a) => {
      if (a.dataset.go === cur) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }
  $("#tabbar").addEventListener("click", (e) => {
    const a = e.target.closest("[data-go]");
    if (!a) return;
    e.preventDefault();
    const go = a.dataset.go;
    if (go === tabbarSection() && go !== "" && panel.dataset.view !== "line") return;
    if (go === "ir") { openTrip(); return; }
    if (go === "") { $("#q").value = ""; navigate(""); return; }
    navigate(go);
  });

  function goBack() {
    if (history.state && history.state.d > 0) history.back();   // popstate llama a route()
    else navigate("", { replace: true });
  }
  function route() {
    if (!stops.length) return;
    const h = decodeURIComponent(location.hash.slice(1));
    if (h === "ir" || h.startsWith("ir/")) { showTrip(h); return; }
    if (h === "info") { showInfo(); return; }
    // Pantallas propias de la barra de secciones (rediseño, fase 1).
    if (h === "favoritas") { showHome("fav"); return; }
    if (h === "lineas") { showHome("lines"); return; }
    // #horario/<parada>[/<línea>]: horarios de una parada, de todas sus líneas o de una (35).
    if (h.startsWith("horario/")) {
      const [sid, ln, head] = h.slice(8).split("/").map(decodeURIComponent);
      if (ln && !lines) { linesReady.then(() => { if (decodeURIComponent(location.hash.slice(1)) === h) route(); }); return; }
      if (byId.has(sid)) {
        // Desde un ramal: su letrero ya elegido en todas las tarjetas de esa línea.
        if (head && ln) for (let d = 0; d < 2; d++) schedPick.set(`${ln}|${d}`, norm(head));
        showSched(sid, ln && lines && lines[ln] ? ln : null);
        return;
      }
    }
    if (h.startsWith("dir/") && showPlace(h.slice(4))) return;
    if (h.startsWith("linea/")) {
      // #linea/18A, #linea/18A/5660 (abierta desde esa parada: se ve el próximo bus hacia ella) o
      // #linea/A/14225/<letrero>: solo los viajes con ese letrero, como si fueran una línea aparte.
      const [code, from, ...rest] = h.slice(6).split("/");
      if (!lines) return;                      // se reintenta al cargar las líneas
      if (lines[code]) { showLine(code, byId.has(from) ? from : null, byId.has(from) && rest.length ? rest.join("/") : null); return; }
      toast(t("no_line", { code }));
    } else if (h && byId.has(h)) {
      showStop(h); return;
    } else if (h) {
      toast(t("no_stop", { id: h }));
    }
    showHome();
  }
  addEventListener("popstate", route);

  function showView(id) {
    if (id !== "line" && id !== "sched") lineTab = "";
    ["home", "line", "stop", "trip", "place", "info", "sched"].forEach((v) => ($(`#${v}`).hidden = v !== id));
    panel.dataset.view = id;
    if (id !== "home") {
      panel.dataset.screen = id === "info" ? "info" : "";
      $("#screen-head").hidden = id !== "info";
      $("#screen-extra").hidden = true;
      if (id === "info") $("#screen-title").textContent = t("nav_more");
    }
    updateTabbar();
    if (id !== "trip") leaveTrip();
    if (id !== "place") leavePlace();
  }

  function leaveStop() {
    if (!current) return;
    current = null;
    clearTimeout(refreshTimer);
    if (fetchCtl) fetchCtl.abort();
    selRing.remove();
  }

  // Inicio (Buscar) y las pantallas propias de Favoritas y Líneas: la misma vista con otra lista.
  function showHome(which = "near") {
    leaveStop();
    clearLine();
    showView("home");
    const own = which !== "near";
    if (own) $("#q").value = "";
    TABS.forEach((x) => $(`#tab-${x}`).setAttribute("aria-selected", x === which));
    mode = which;
    panel.dataset.screen = own ? which : "home";
    $("#screen-head").hidden = !own;
    $("#screen-extra").hidden = !own;
    if (!own || which !== "lines") { $("#screen-extra").replaceChildren(); delete $("#screen-extra").dataset.kind; }
    $("#screen-title").textContent = own ? t(which === "fav" ? "tab_fav" : "tab_lines") : "";
    if (!isDesktop()) panel.dataset.state = own ? "full" : (panel.dataset.state === "full" ? "peek" : panel.dataset.state || "peek");
    document.title = own ? `${$("#screen-title").textContent} · ${APP_NAME}` : APP_NAME;
    updateTabbar();
    render();
  }

  // ---------- Línea iluminada ----------
  function clearLine() {
    if (!active) return;
    active = null;
    stopTrack();
    stopFleet();
    lineGroup.clearLayers();
    selRing.remove();
    updateStopVisibility();
    restyleStops();
  }

  function drawLine() {
    const l = lines[active.code];
    lineGroup.clearLayers();
    // Solo el sentido elegido: su trazado y sus paradas.
    const dir = l.sentidos[active.dir];
    const v = active.variant && active.variant.main ? active.variant : null;
    active.stops = new Set(v ? [...v.main, ...v.extra] : [...dir.paradas, ...(dir.otras || [])]);
    updateStopVisibility();
    restyleStops();
    // Variante: su recorrido pasando por sus paradas (y, más fino, el de sus viajes distintos).
    if (v) {
      v.others.forEach((ids) => thinStroke(pathThrough(dir, ids), l.color));
      lineStroke(pathThrough(dir, v.main), l.color);
      return;
    }
    // Trazado con borde para que se vea sobre cualquier fondo.
    // Ramales (solo algunos viajes): trazo continuo más fino, debajo del recorrido principal.
    (dir.ramales || []).forEach((r, k) => {
      const rp = decodePolyline(r);
      L.polyline(rp, { renderer, color: "#13222C", weight: 7, opacity: 0.25, interactive: false }).addTo(lineGroup);
      L.polyline(rp, { renderer, color: "#FFFFFF", weight: 6, opacity: 1, interactive: false }).addTo(lineGroup);
      L.polyline(rp, { renderer, color: l.color, weight: 3.5, opacity: 0.9, interactive: false, lineCap: "round" }).addTo(lineGroup);
    });
    lineStroke(decodePolyline(dir.trazado), l.color);
  }
  function thinStroke(rp, color) {
    L.polyline(rp, { renderer, color: "#13222C", weight: 7, opacity: 0.25, interactive: false }).addTo(lineGroup);
    L.polyline(rp, { renderer, color: "#FFFFFF", weight: 6, opacity: 1, interactive: false }).addTo(lineGroup);
    L.polyline(rp, { renderer, color, weight: 3.5, opacity: 0.9, interactive: false, lineCap: "round" }).addTo(lineGroup);
  }
  // Paradas de una variante (los viajes de esa línea y sentido con un letrero), del horario: la
  // secuencia del recorrido con más viajes que pasa por la parada de origen; las de sus otros
  // recorridos, aparte ("solo algunos viajes").
  function loadVariant(act) {
    PLAN.load().then((plan) => {
      if (active !== act || !act.variant) return;
      const r = norm(act.variant.ruta);
      const fi = plan.index.get(act.from);
      const pats = plan.pats.filter((pt) => pt.l === act.code && pt.s === act.dir && pt.h && pt.h.some((x) => norm(x) === r))
        .sort((a, b) => (b.p.includes(fi) - a.p.includes(fi)) || (b.dep.length - a.dep.length));
      if (!pats.length) return;   // letrero que no está en el horario: la línea entera
      const ids = (pt) => pt.p.map((i) => plan.ids[i]).filter((id) => byId.has(id));
      const main = ids(pats[0]);
      const others = pats.slice(1).map(ids).filter((x) => x.length > 1);
      const seen = new Set(main);
      const extra = [];
      others.forEach((x) => x.forEach((id) => { if (!seen.has(id)) { seen.add(id); extra.push(id); } }));
      Object.assign(act.variant, { main, extra, others });
      renderLineStops();
      drawLine();
      drawBus();
    }).catch(() => {});
  }
  function lineStroke(pts, color) {
    L.polyline(pts, { renderer, color: "#13222C", weight: 11, opacity: 0.35, interactive: false }).addTo(lineGroup);
    L.polyline(pts, { renderer, color: "#FFFFFF", weight: 9, opacity: 1, interactive: false }).addTo(lineGroup);
    L.polyline(pts, { renderer, color, weight: 6, opacity: 1, interactive: false, lineCap: "round" }).addTo(lineGroup);
  }
  // Trazados (-1 principal, k ramal k) que hace un bus con este letrero, o null si no se sabe.
  function branchesOf(d, ruta) {
    if (!d || !d.trazados || !ruta) return null;
    const r = norm(String(ruta));
    const k = Object.keys(d.trazados).find((x) => norm(x) === r);
    return k ? d.trazados[k] : null;
  }

  // ¿Se ve este punto en la zona del mapa que no tapa el panel?
  function inView(ll) {
    const p = map.latLngToContainerPoint(ll), size = map.getSize(), m = 24;
    const left = isDesktop() ? panel.getBoundingClientRect().right : 0;
    const bottom = isDesktop() ? size.y : size.y - panelCover();
    return p.x > left + m && p.x < size.x - m && p.y > m && p.y < bottom - m;
  }

  // Encuadra unos puntos en la zona del mapa que no tapa el panel.
  // Altura que tapa el panel en el móvil, según su estado final (no la de mitad de animación).
  function panelCover() {
    const st = panel.dataset.state;
    return st === "full" ? innerHeight - 56 : st === "stop" ? innerHeight * 0.64 : st === "min" ? 92 : Math.max(260, innerHeight * 0.46);
  }
  function fitPoints(pts, maxZoom) {
    const r = panel.getBoundingClientRect();
    const opts = isDesktop()
      ? { paddingTopLeft: [r.right + 24, 24], paddingBottomRight: [24, 24] }
      : { paddingTopLeft: [16, 16], paddingBottomRight: [16, panelCover() + 16] };
    map.fitBounds(L.latLngBounds(pts), { ...opts, maxZoom });
  }

  function fitLine() {
    const l = lines[active.code];
    const d = l.sentidos[active.dir];
    fitPoints([d.trazado, ...(d.ramales || [])].flatMap(decodePolyline), 16);
  }

  let lineAllNext = false;   // "Ver la línea completa" desde una variante: la línea entera, sin recortar
  function showLine(code, from = null, variant = null) {
    leaveStop();
    const changed = !active || active.code !== code || active.from !== from || (active.variant ? active.variant.ruta : null) !== variant;
    if (changed) {
      clearLine();
      // Abierta desde una parada: el sentido que pasa por ella (si pasan los dos, el de la fila tocada).
      const dirWith = from ? dirThrough(lines[code], from, variant || lineRuta) : -1;
      active = { code, dir: Math.max(0, dirWith), stops: new Set(), from, fromDir: dirWith,
        variant: variant && dirWith >= 0 ? { ruta: variant } : null };
      if (active.variant) loadVariant(active);
    }
    const l = lines[code];
    const v = active.variant;
    showView("line");
    const badge = $("#line-badge");
    badge.textContent = code;
    badge.style.setProperty("--lc", l.color);
    badge.style.setProperty("--lt", l.texto);
    // Variante (un letrero): su destino como título y, en lugar de los sentidos, "ver toda la línea".
    if (changed) { active.all = lineAllNext; lineAllNext = false; }
    // Desde una parada, solo los sentidos que pasan por ella (pestañas solo si pasan los dos).
    const dirs = l.sentidos.map((d, i) => i).filter((i) => !from || l.sentidos[i].paradas.includes(from) || (l.sentidos[i].otras || []).includes(from));
    $("#line-dirs").hidden = !!v || dirs.length < 2;
    $("#line-dirs").innerHTML = dirs.map((i) =>
      `<button role="tab" type="button" data-dir="${i}" aria-selected="${i === active.dir}">${esc(t("towards", { dest: l.sentidos[i].destino }))}</button>`).join("");
    renderLineStops();
    document.title = `${t("line_n", { code })} · ${APP_NAME}`;
    if (!isDesktop()) panel.dataset.state = "peek";
    drawLine();
    if (changed) {
      const origin = from && byId.get(from);
      // Desde una parada: un poco más alejado que la ficha, pero sin encuadrar la línea entera;
      // el usuario aleja el mapa si quiere verla completa.
      if (origin) { focusOn(origin.ll, LINE_STOPS_ZOOM); selRing.setLatLng(origin.ll).addTo(map); }
      else fitLine();
      startTrack();
      startFleet();
    } else drawBus();
    renderBusCard();
    lineRuta = null;
  }

  // ¿Va el bus con letrero "ruta" (dato de la API) en este sentido? Cada sentido tiene su
  // destino principal y otros letreros de algunos viajes ("Xestoso por Hospital"…).
  function goesTo(d, ruta) {
    if (!d || !ruta) return false;
    const r = norm(String(ruta));
    return norm(d.destino) === r || (d.letreros || []).some((x) => norm(x) === r);
  }

  // Sentido de la línea que pasa por una parada; si pasan varios, el que va hacia "ruta".
  function dirThrough(l, id, ruta) {
    const idx = l.sentidos.map((d, i) => (d.paradas.includes(id) || (d.otras || []).includes(id) ? i : -1)).filter((i) => i >= 0);
    if (idx.length > 1 && ruta) {
      const hit = idx.find((i) => goesTo(l.sentidos[i], ruta));
      if (hit != null) return hit;
    }
    return idx.length ? idx[0] : -1;
  }

  // ---------- Próximo bus hacia la parada ----------
  // Con la línea abierta desde una parada, se pide cada 30 s la llegada a esa parada y se dibuja
  // el bus más próximo sobre el trazado: distancia de la parada a lo largo del recorrido menos los
  // metros que da la API. Entre actualizaciones avanza a su velocidad media (metros / minutos).
  const BUS = window.PV_BUS;
  let track = null;   // { stop, code, dir, loc, est, at, state, timer, tick, ctl, marker }

  function stopTrack() {
    if (!track) return;
    clearTimeout(track.timer);
    clearInterval(track.tick);
    if (track.ctl) track.ctl.abort();
    (track.markers || []).forEach((mk) => mk.remove());
    track = null;
    $("#line-bus").hidden = true;
  }

  function startTrack() {
    stopTrack();
    if (!BUS || !active || !active.from || active.fromDir < 0) return;
    const dir = lines[active.code].sentidos[active.fromDir];
    const loc = BUS.locateStop(dir, active.from, (id) => (byId.get(id) || {}).ll || [0, 0]);
    if (!loc) return;
    track = { stop: active.from, code: active.code, dir: active.fromDir, loc, est: null, at: 0, state: "loading" };
    // Recién venidos de la ficha de esa parada: se reutilizan sus datos en vez de pedirlos otra vez.
    const age = lastUpdate ? Date.now() - lastUpdate.getTime() : Infinity;
    if (lastArrivals && lastArrivalsId === track.stop && age < REFRESH_MS - 5000) {
      applyEstimates(lastArrivals, lastUpdate.getTime());
      track.timer = setTimeout(fetchTrack, REFRESH_MS - age);
    } else fetchTrack();
    track.tick = setInterval(() => { drawBus(); renderBusCard(); }, 1000);
  }

  async function fetchTrack() {
    const tr = track;
    if (!tr) return;
    clearTimeout(tr.timer);
    if (tr.ctl) tr.ctl.abort();
    const ctl = (tr.ctl = new AbortController());
    const timeout = setTimeout(() => ctl.abort(), 10000);
    try {
      const data = await fetchEstimates(tr.stop, ctl.signal);
      if (track !== tr) return;
      applyEstimates(data.estimaciones || [], Date.now());
    } catch {
      if (track !== tr || ctl.signal.aborted && tr.ctl !== ctl) return;
      if (!tr.est) { tr.state = "error"; renderBusCard(); }
    } finally {
      clearTimeout(timeout);
    }
    if (track === tr) tr.timer = setTimeout(() => { if (!document.hidden) fetchTrack(); }, REFRESH_MS);
  }

  // Elige el bus más próximo de la línea (y del destino, si en la parada paran los dos sentidos).
  function applyEstimates(list, at) {
    const tr = track;
    const l = lines[tr.code];
    let mine = list.filter((e) => normLine(e.linea) === tr.code && !isNaN(Number(e.minutos)));
    const both = l.sentidos.filter((d) => d.paradas.includes(tr.stop) || (d.otras || []).includes(tr.stop)).length > 1;
    // Variante: solo los buses con su letrero.
    const v = active && active.code === tr.code && active.variant;
    if (v) mine = mine.filter((e) => norm(String(e.ruta || "")) === norm(v.ruta));
    else if (both) {
      const same = mine.filter((e) => goesTo(l.sentidos[tr.dir], e.ruta));
      if (same.length) mine = same;
    }
    mine.sort((a, b) => Number(a.minutos) - Number(b.minutos));
    // Posición del bus: sobre el trazado de su letrero si es un único ramal que pasa por la parada.
    const d = l.sentidos[tr.dir];
    const only = mine[0] ? branchesOf(d, mine[0].ruta) : null;
    tr.loc = tr.baseLoc = tr.baseLoc || tr.loc;
    if (only && only.length === 1 && only[0] >= 0 && d.ramales[only[0]]) {
      const sh = BUS.prepare(BUS.decode(d.ramales[only[0]]));
      const p = BUS.project(sh, byId.get(tr.stop).ll);
      if (p.off < 60) tr.loc = { shape: sh, along: p.along, off: p.off, branch: only[0] };
    }
    tr.ests = mine;
    tr.est = mine[0] || null;
    tr.at = at;
    tr.state = tr.est ? "ok" : "none";
    drawBus();
    renderBusCard();
    // La primera vez que se sabe dónde va, si queda fuera de la vista se encuadran bus y parada.
    const b = busNow();
    if (!tr.framed && b && b.state === "route" && active && active.dir === tr.dir) {
      tr.framed = true;
      const s = byId.get(tr.stop);
      const frame = () => { if (track === tr && s && !inView(b.ll)) fitPoints([b.ll, s.ll], LINE_STOPS_ZOOM); };
      // Si el mapa aún se está moviendo hacia la parada, se espera a que termine.
      if (map._animatingZoom || (map._panAnim && map._panAnim._inProgress)) map.once("moveend", frame); else frame();
    }
  }

  // Situación de un bus ahora mismo (avanza entre actualizaciones); i = 0, el más próximo.
  function busNow(i = 0) {
    const est = track && (track.ests || [])[i];
    if (!est) return null;
    return busState({ loc: track.loc, est, at: track.at });   // con "cabecera" (38), como en Cómo llegar
  }

  // Bus en marcha (mockups 2 y 5): un autobús de lado, blanco, con las ventanas del color de la línea.
  const BUS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="bw" d="M3.5 6h15.2a2.3 2.3 0 0 1 2.2 1.6l1.1 3.6V16a1 1 0 0 1-1 1H3.5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 3.5 6z"/><rect class="bc" x="4" y="8" width="3.6" height="3.4" rx=".6"/><rect class="bc" x="8.6" y="8" width="3.6" height="3.4" rx=".6"/><rect class="bc" x="13.2" y="8" width="3.6" height="3.4" rx=".6"/><path class="bc" d="M17.8 8h1.3l1.1 3.4h-2.4z"/><circle class="bw bs" cx="7" cy="17" r="2.1"/><circle class="bw bs" cx="17" cy="17" r="2.1"/></svg>';

  // Bus en vivo en el mapa: destacado (anillo y pulso del color de la línea) y, a su lado, lo que
  // le falta para llegar a la parada. Lo usan la línea abierta desde una parada y Cómo llegar.
  function busMarker(color, texto, ll) {
    return L.marker(ll, { keyboard: false, interactive: false, zIndexOffset: 900, icon: L.divIcon({
      className: "bus-pin", iconSize: [40, 40], iconAnchor: [20, 20],
      html: `<span class="bus-dot" style="--lc:${color};--lt:${texto}"><span class="bus-arrow"></span>${BUS_ICON}</span><span class="bus-eta" style="--lc:${color};--lt:${texto}"></span>`,
    }) });
  }
  function placeBus(marker, s, est, at) {
    marker.setLatLng(s.ll);
    if (!map.hasLayer(marker)) marker.addTo(map);
    const el = marker.getElement();
    if (!el) return;
    el.querySelector(".bus-arrow").style.transform = `rotate(${Math.round(s.bearing)}deg)`;
    // El autobús mira hacia donde va: hacia el oeste, dado la vuelta.
    el.querySelector(".bus-dot > svg").style.transform = ((s.bearing % 360) + 360) % 360 > 180 ? "scaleX(-1)" : "";
    const m = Math.round(Number(est.minutos) - (Date.now() - at) / 60000);
    el.querySelector(".bus-eta").textContent = m <= 0 ? t("arriving") : hMin(m);
  }

  function drawBus() {
    const tr = track;
    if (!tr) return;
    tr.markers = tr.markers || [];
    // Todos los buses que la API da camino de la parada, en el sentido que va hacia ella.
    (tr.ests || []).forEach((est, i) => {
      const b = busNow(i);
      let mk = tr.markers[i];
      if (!b || (b.state !== "route" && b.state !== "head") || !active || active.dir !== tr.dir) { if (mk) mk.remove(); return; }
      if (!mk) { const l = lines[tr.code]; mk = tr.markers[i] = busMarker(l.color, l.texto, b.ll); }
      placeBus(mk, b, est, tr.at);
      if (b.state === "head") setBusLabel(mk, t("bus_head"));
    });
    tr.markers.slice((tr.ests || []).length).forEach((mk) => mk.remove());
    drawFleet();
  }
  const setBusLabel = (mk, txt) => { const el = mk.getElement(); if (el) el.querySelector(".bus-eta").textContent = txt; };

  // ---------- Todos los buses en vivo de la línea (46) ----------
  // La API solo da, por parada, los buses que van hacia ella. Para ver los de toda la línea (también
  // los que ya pasaron la parada de origen, o la línea abierta sin parada) se consultan unas pocas
  // paradas repartidas por el recorrido del sentido que se ve (una cada FLEET_SPACING m, la última
  // incluida, como mucho FLEET_MAX) y cada bus se coloca desde la más cercana. Un mismo bus sale en
  // varias paradas: se juntan los del mismo letrero a menos de FLEET_SAME m (sin identificador de
  // vehículo en la API, no hay otra forma). Sin minutos en la etiqueta (no van hacia una parada
  // elegida); los que vienen hacia la parada de origen los dibuja drawBus() con sus minutos.
  const FLEET_SPACING = 2500, FLEET_MAX = 6, FLEET_SAME = 350;
  let fleet = null;   // { code, dir, probes: [{ id, loc }], cands, markers, timer, tick }
  function stopFleet() {
    if (!fleet) return;
    clearTimeout(fleet.timer);
    clearInterval(fleet.tick);
    fleet.markers.forEach((mk) => mk.remove());
    fleet = null;
  }
  function startFleet() {
    stopFleet();
    if (!BUS || !active) return;
    const d = lines[active.code].sentidos[active.dir];
    const llOf = (id) => (byId.get(id) || {}).ll || [0, 0];
    const sh = BUS.prepare(BUS.decode(d.trazado));
    const along = BUS.stopsAlong(sh, d.paradas.map(llOf)).map((r) => r.along);
    const ids = [];
    const gap = Math.max(FLEET_SPACING, sh.length / FLEET_MAX);   // líneas largas: más separadas
    let next = Infinity;
    for (let k = d.paradas.length - 1; k > 0 && ids.length < FLEET_MAX; k--) {
      if (along[k] <= next) { ids.push(d.paradas[k]); next = along[k] - gap; }
    }
    const probes = [...new Set(ids)].map((id) => ({ id, loc: BUS.locateStop(d, id, llOf) })).filter((p) => p.loc);
    fleet = { code: active.code, dir: active.dir, probes, cands: [], markers: [] };
    fetchFleet();
    fleet.tick = setInterval(drawFleet, 1000);
  }
  async function fetchFleet() {
    const fl = fleet;
    if (!fl) return;
    clearTimeout(fl.timer);
    if (!document.hidden) {
      const res = await Promise.all(fl.probes.map((p) => getLive(p.id)));
      if (fleet !== fl) return;
      const l = lines[fl.code], d = l.sentidos[fl.dir];
      const v = active && active.code === fl.code && active.variant;
      const cands = [];
      res.forEach((e, i) => {
        if (!e || !e.list) return;
        const p = fl.probes[i];
        const both = l.sentidos.filter((x) => x.paradas.includes(p.id) || (x.otras || []).includes(p.id)).length > 1;
        e.list.forEach((est) => {
          if (normLine(est.linea) !== fl.code || !isFinite(Number(est.minutos)) || !isFinite(Number(est.metros))) return;
          if (v ? norm(String(est.ruta || "")) !== norm(v.ruta) : both && !goesTo(d, est.ruta)) return;
          // Letrero de un solo ramal: su posición, sobre ese ramal (si la parada está en él).
          let loc = p.loc;
          const only = branchesOf(d, est.ruta);
          if (only && only.length === 1 && only[0] >= 0 && d.ramales && d.ramales[only[0]]) {
            const bsh = BUS.prepare(BUS.decode(d.ramales[only[0]]));
            const pr = BUS.project(bsh, byId.get(p.id).ll);
            if (pr.off >= 60) return;
            loc = { shape: bsh, along: pr.along, off: pr.off, branch: only[0] };
          }
          cands.push({ loc, est, at: e.at, ruta: norm(String(est.ruta || "")), metros: Number(est.metros) });
        });
      });
      cands.sort((a, b) => a.metros - b.metros);   // primero, el visto desde la parada más cercana
      fl.cands = cands;
      drawFleet();
    }
    fl.timer = setTimeout(fetchFleet, REFRESH_MS);
  }
  function drawFleet() {
    const fl = fleet;
    if (!fl) return;
    const shown = active && active.code === fl.code && active.dir === fl.dir;
    // Ya dibujados por drawBus() (los que van hacia la parada de origen, con sus minutos).
    const kept = [];
    if (shown && track && track.dir === fl.dir) (track.ests || []).forEach((est, i) => {
      const b = busNow(i);
      if (b && (b.state === "route" || b.state === "head")) kept.push({ ll: b.ll, ruta: norm(String(est.ruta || "")) });
    });
    const out = [];
    if (shown) fl.cands.forEach((c) => {
      const b = busState(c);
      if (!b || (b.state !== "route" && b.state !== "head")) return;
      if ([...kept, ...out].some((k) => k.ruta === c.ruta && haversine(k.ll, b.ll) < FLEET_SAME)) return;
      out.push({ ll: b.ll, ruta: c.ruta, b, c });
    });
    const l = lines[fl.code];
    out.forEach((o, i) => {
      const mk = fl.markers[i] || (fl.markers[i] = busMarker(l.color, l.texto, o.b.ll));
      placeBus(mk, o.b, o.c.est, o.c.at);
      setBusLabel(mk, o.b.state === "head" ? t("bus_head") : "");
    });
    fl.markers.slice(out.length).forEach((mk) => mk.remove());
  }

  // Próximo paso según el horario por la parada del seguimiento, de esa línea y sentido (y, en una
  // variante, con su letrero): segundos desde la medianoche de hoy, null si no hay en 6 h o
  // undefined si aún no han cargado los horarios.
  function nextScheduled(tr) {
    if (!stopPlan) { PLAN.load().then((pl) => { stopPlan = pl; renderBusCard(); }).catch(() => {}); return undefined; }
    const si = stopPlan.index.get(tr.stop);
    if (si == null) return null;
    const v = active && active.variant ? norm(active.variant.ruta) : null;
    const now = new Date();
    const nowS = (now - dayBase(now)) / 1000;
    const x = stopPlan.upcoming(si, now, 6 * 3600, 0).find((p) => {
      const pt = stopPlan.pats[p.pat];
      return pt.l === tr.code && pt.s === tr.dir && p.at >= nowS - 30 && (!v || (pt.h && pt.h.some((h) => norm(h) === v)));
    });
    return x ? x.at : null;
  }

  function renderBusCard() {
    const card = $("#line-bus");
    const tr = track;
    if (!tr || !active) { card.hidden = true; return; }
    const l = lines[tr.code];
    const s = byId.get(tr.stop);
    card.style.setProperty("--lc", l.color);
    card.style.setProperty("--lt", l.texto);
    if (active.dir !== tr.dir) { card.hidden = true; return; }   // no debería pasar: solo se ven sentidos que pasan por la parada
    const b = busNow();
    let main, sub = "";
    if (tr.state === "loading") main = "…";
    else if (tr.state === "error" || tr.state === "none") {
      // Sin bus en vivo: el próximo paso según el horario publicado.
      const at = nextScheduled(tr);
      if (at) {
        main = `<span class="sc">${esc(t(tr.state === "error" ? "card_sched_err" : "card_sched"))}</span>`;
        sub = `<span class="eta sched"><b>${esc(hhmm(at))}</b></span>`;
      } else main = esc(t(tr.state === "error" ? "times_error" : "bus_none"));
    } else if (b && (b.state === "depot" || b.state === "head")) {
      const m = Math.max(0, Math.round(Number(tr.est.minutos) - (Date.now() - tr.at) / 60000));
      main = `${esc(t("bus_depot"))}`;
      sub = `<span class="eta">${etaNum(m)}</span>`;
    } else if (b) {
      const m = Math.round(Number(tr.est.minutos) - (Date.now() - tr.at) / 60000);
      main = `<span class="lv">${esc(t("live_word"))} · ${esc(t("at_dist", { d: fmtDist(b.left) }))}</span>`;
      sub = m <= 0 ? `<span class="eta now"><b>${esc(t("arriving"))}</b></span>`
                   : `<span class="eta">${etaNum(m)}</span>`;
    } else main = esc(t("bus_none"));
    card.innerHTML = `<span class="bus-dot" style="--lc:${l.color}">${BUS_ICON}</span>
      <span class="what"><b>${esc(tr.stop === active.from ? t("bus_title_short") : t("bus_title", { stop: s ? s.name : tr.stop }))}</b><small>${main}</small></span>${sub}`;
    card.hidden = false;
  }

  // Tocar la tarjeta: muestra el bus y la parada en el mapa (volviendo a su sentido si hace falta).
  $("#line-bus").addEventListener("click", () => {
    const tr = track;
    if (!tr) return;
    if (active.dir !== tr.dir) {
      active.dir = tr.dir;
      $("#line-dirs").querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", Number(x.dataset.dir) === tr.dir));
      renderLineStops();
      drawLine();
      drawBus();
    }
    const s = byId.get(tr.stop);
    const b = busNow();
    if (b && b.state === "route") fitPoints([b.ll, s.ll], 17);
    else if (s) focusOn(s.ll, LINE_STOPS_ZOOM);
  });

  // Minutos desde la parada "from" hasta las siguientes de la línea, con la duración típica (la
  // mediana) de sus viajes en el horario publicado. null si no se sabe.
  function lineMinutes(code, dir, from) {
    if (!from) return null;
    if (!stopPlan) { PLAN.load().then((pl) => { stopPlan = pl; if (active && active.code === code && !$("#line").hidden) renderLineStops(); }).catch(() => {}); return null; }
    const si = stopPlan.index.get(from);
    if (si == null) return null;
    let best = null;
    for (const [n, k] of stopPlan.at[si]) {
      const pt = stopPlan.pats[n];
      if (pt.l !== code || pt.s !== dir || !pt.dur.length) continue;
      if (!best || pt.p.length - k > best.pt.p.length - best.k) best = { pt, k };
    }
    if (!best) return null;
    const { pt, k } = best;
    const ds = [...pt.dur].sort((x, y) => x - y), dur = ds[ds.length >> 1];
    const m = new Map();
    for (let j = k; j < pt.p.length; j++) m.set(stopPlan.ids[pt.p[j]], Math.round((pt.t[j] - pt.t[k]) * dur / 60));
    return m;
  }
  // Paradas de la línea como en el mockup (5): abierta desde una parada, desde ella en adelante con
  // los minutos hasta cada una ("Ver la línea completa" enseña también las de antes).
  function renderLineStops() {
    const l = lines[active.code];
    const dir = l.sentidos[active.dir];
    const v = active.variant && active.variant.main ? active.variant : null;
    const from = active.from && byId.get(active.from);
    $("#line-name").textContent = active.variant ? titleCase(active.variant.ruta) : from ? dir.destino : l.nombre;
    $("#line-sub").textContent = from ? t("from_stop", { stop: from.name }) : "";
    const list = $("#line-stops");
    list.style.setProperty("--lc", l.color);
    const ids = (v ? v.main : dir.paradas);
    const k0 = active.from ? ids.indexOf(active.from) : -1;
    const cut = k0 > 0 && !active.all;
    $("#line-whole").hidden = !(active.variant || cut);
    const shown = (cut ? ids.slice(k0) : ids).map((id) => byId.get(id)).filter(Boolean);
    const mins = lineMinutes(active.code, active.dir, active.from);
    const row = (s, i, n, branch) => {
      const li = document.createElement("li");
      const mine = s.id === active.from;
      const m = mins && !mine ? mins.get(s.id) : null;
      li.className = `lrow${i === 0 ? " first" : ""}${i === n - 1 ? " last" : ""}${mine ? " mine" : ""}${branch ? " branch" : ""}`;
      li.innerHTML = `<button type="button" data-id="${esc(s.id)}"><span class="rail"><i></i></span>
        <span class="name">${esc(s.name)}${mine ? ` <small>· ${esc(t("your_stop"))}</small>` : ""}</span>
        <span class="r">${m != null ? esc(hMin(Math.max(1, m))) : esc(s.id)}</span></button>`;
      return li;
    };
    const items = shown.map((s, i) => row(s, i, shown.length));
    const extra = (v ? v.extra : dir.otras || []).map((id) => byId.get(id)).filter(Boolean);
    if (extra.length) {
      const head = groupHead(t("some_trips"));
      head.classList.add("branch-head");
      items.push(head, ...extra.map((s, i) => row(s, i, extra.length, true)));
    }
    list.replaceChildren(...items);
    $("#line-stops").scrollTop = 0;
  }

  // ---------- Ficha de parada ----------
  function showStop(id, { repaint = false } = {}) {
    const s = byId.get(id);
    if (current !== s) leaveStop();
    if (!repaint) clearLine();   // la ficha de parada se ve sin la línea anterior encima
    current = s;
    showView("stop");
    $("#stop-name").textContent = s.name;
    // Como en el mockup (4): "Parada 8820 · 20 líneas"; las chapas de las líneas, al final de la hoja.
    $("#stop-id").textContent = `${t("stop_n", { id: s.id })} · ${nLines(s.lines.length)}`;
    $("#stop-lines").innerHTML = s.lines.map((l) => lineChip(l)).join("");
    $("#stop-dist").textContent = "";
    $("#infobus").href = INFOBUS_URL(s.id);
    updateFavBtn();
    document.title = `${s.name} · ${APP_NAME}`;
    if (repaint) return;           // solo volver a escribir los textos (cambio de idioma)
    if (!isDesktop()) panel.dataset.state = "stop";
    selRing.setLatLng(s.ll).addTo(map);
    focusOn(s.ll);
    loadArrivals(true);
    // Horarios publicados (para el horario previsto y el retraso): en segundo plano.
    PLAN.load().then((pl) => {
      stopPlan = pl;
      if (current === s && lastArrivalsId === s.id && lastUpdate) renderArrivals(lastArrivals);
      else if (current === s && arrivalsFailed) renderArrivals(null);
    }).catch(() => {});
  }

  function updateFavBtn() {
    const on = current && !!favStop(current.id);
    const b = $("#fav");
    b.setAttribute("aria-pressed", !!on);
    b.setAttribute("aria-label", on ? t("fav_remove") : t("fav_add"));
  }

  function skeleton() {
    return Array.from({ length: 4 }, () =>
      `<div class="arrival skeleton" aria-hidden="true"><span class="badge">00</span><span class="route"><b>&nbsp;</b></span><span class="eta"><b>00</b></span></div>`
    ).join("");
  }

  // Pide los próximos buses de una parada a la API del Concello.
  async function fetchEstimates(id, signal) {
    const url = `${API_URL}?id=${encodeURIComponent(id)}&ttl=5&tipo=TRANSPORTE-ESTIMACION-PARADA`;
    const r = await fetch(url, { signal, cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    // La API puede responder en Latin-1 sin avisar: si no es UTF-8 válido, se lee como Windows-1252
    // para que las tildes y la ñ no salgan como "�".
    const buf = await r.arrayBuffer();
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch { text = new TextDecoder("windows-1252").decode(buf); }
    const data = JSON.parse(text);
    // Algunos letreros de la API llevan un asterisco ("R. NIETO - CAEIRO*") sin explicación oficial
    // (60): se quita y se enseña el letrero tal cual, sin suponer qué significa.
    (data.estimaciones || []).forEach((x) => { if (x && x.ruta != null) x.ruta = String(x.ruta).replace(/\*/g, "").trim(); });
    feedLive(id, data.estimaciones, Date.now());
    return data;
  }

  // Horario en vivo: cada respuesta de la API (de cualquier parte de la web) apunta en el
  // planificador el retraso de los buses que se pueden emparejar con su viaje del horario. Cómo
  // llegar busca sobre ese horario (ver PV_PLAN.observe).
  function feedLive(id, list, atMs) {
    if (!Array.isArray(list) || !list.length) return;
    PLAN.load().then((pl) => {
      const i = pl.index.get(id);
      if (i == null) return;
      pl.observe(i, list.map((b) => {
        const line = normLine(b.linea);
        return { line, dir: lines ? liveDir(id, line, b.ruta) : null, ruta: b.ruta, minutos: b.minutos };
      }), atMs);
    }).catch(() => {});
  }

  async function loadArrivals(first) {
    const s = current;
    if (!s) return;
    clearTimeout(refreshTimer);
    if (fetchCtl) fetchCtl.abort();
    const ctl = (fetchCtl = new AbortController());
    const seq = ++reqSeq;
    const box = $("#arrivals");
    if (first) { box.innerHTML = skeleton(); lastUpdate = null; showUpdated(); }
    const timeout = setTimeout(() => ctl.abort(), 10000);
    try {
      const data = await fetchEstimates(s.id, ctl.signal);
      if (seq !== reqSeq) return;
      // El nombre oficial sustituye a los genéricos tipo "Parada 1234".
      const official = data.parada && data.parada[0] && data.parada[0].nombre;
      if (official && /^Parada \d/.test(s.name)) $("#stop-name").textContent = titleCase(official);
      lastArrivalsId = s.id;
      renderArrivals(data.estimaciones || []);
      lastUpdate = new Date();
      showUpdated();
    } catch (e) {
      if (seq !== reqSeq) return;
      renderArrivals(null);   // sin respuesta: aviso y, debajo, el horario previsto
      lastUpdate = null;
      showUpdated();
    } finally {
      clearTimeout(timeout);
    }
    if (seq === reqSeq && current === s) refreshTimer = setTimeout(() => { if (!document.hidden) loadArrivals(false); }, REFRESH_MS);
  }

  let lastUpdate = null;
  let lastArrivals = null;          // para volver a pintar al cambiar de idioma
  let lastArrivalsId = null;        // parada de esos datos (los reutiliza el bus en el mapa)
  function showUpdated() {
    $("#updated").textContent = lastUpdate
      ? t("updated", { time: lastUpdate.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) }) : "";
  }

  let stopPlan = null;               // horarios publicados (data/viajes.json), cuando han cargado
  let arrivalsFailed = false;        // la última consulta de la API falló
  const SCHED_AHEAD = 90 * 60;       // horario previsto: los pasos de la próxima hora y media

  // Sentido de una línea al que va un bus de la API en esta parada (null si no se sabe).
  function liveDir(id, linea, ruta) {
    const l = lines && lines[linea];
    if (!l) return null;
    const idx = l.sentidos.map((d, i) => (d.paradas.includes(id) || (d.otras || []).includes(id) ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 1) return idx[0];
    const hit = idx.find((i) => goesTo(l.sentidos[i], ruta));
    return hit == null ? null : hit;
  }

  // Retraso o adelanto de un bus en vivo frente a su paso programado (20). Solo si el emparejamiento
  // no tiene duda: pasos de esa línea y sentido separados al menos 15 min y el bus claramente más
  // cerca de uno de ellos. Devuelve minutos (+ tarde, − antes) o null.
  function delayOf(passes, expected, used) {
    let i = -1, best = Infinity;
    passes.forEach((p, k) => { const d = Math.abs(expected - p.at); if (d < best) { best = d; i = k; } });
    if (i < 0 || used.has(i)) return null;
    const gap = Math.min(i > 0 ? passes[i].at - passes[i - 1].at : Infinity, i < passes.length - 1 ? passes[i + 1].at - passes[i].at : Infinity);
    const diff = expected - passes[i].at;
    if (gap < 15 * 60 || Math.abs(diff) > Math.min(gap / 2 - 120, 15 * 60)) return null;
    used.add(i);
    return Math.round(diff / 60);
  }
  const delayHtml = (d) => d == null ? "" : Math.abs(d) <= 1 ? `<small class="ontime">${esc(t("delay_on"))}</small>`
    : d > 0 ? `<small class="late">${esc(t("delay_late", { n: d }))}</small>` : `<small class="early">${esc(t("delay_early", { n: -d }))}</small>`;

  // list: estimaciones de la API ([] si no da ninguna; null si la consulta falló).
  function renderArrivals(list) {
    lastArrivals = list;
    arrivalsFailed = list == null;
    const box = $("#arrivals");
    const s = current;
    const now = new Date();
    const nowS = (now - dayBase(now)) / 1000;
    // Horario publicado de esta parada (si ya ha cargado): pasos de hace 30 min a dentro de 3 h.
    const si = stopPlan && s ? stopPlan.index.get(s.id) : null;
    const passes = si != null ? stopPlan.upcoming(si, now, 3 * 3600, 30 * 60) : [];
    const passesOf = new Map();
    passes.forEach((p) => { const k = `${p.line}|${p.dir}`; if (!passesOf.has(k)) passesOf.set(k, []); passesOf.get(k).push(p); });

    // En vivo: agrupa por línea y destino; el próximo y el siguiente.
    const groups = new Map();
    const covered = new Set();   // líneas y sentidos con algún bus en vivo (no se repiten según horario)
    (list || []).forEach((b) => {
      const linea = normLine(b.linea);
      const ruta = titleCase(String(b.ruta || ""));
      const k = `${linea}|${ruta}`;
      if (!groups.has(k)) groups.set(k, { linea, ruta, raw: String(b.ruta || "").trim(), buses: [], dir: s ? liveDir(s.id, linea, b.ruta) : null });
      groups.get(k).buses.push(Number(b.minutos));
    });
    const rows = [];
    for (const g of groups.values()) {
      const mins = g.buses.filter((m) => !isNaN(m)).sort((a, b) => a - b);
      if (!mins.length) continue;
      // Cubre su letrero (67): si coincide con un letrero del horario, solo ese; si no, toda la línea
      // y sentido (sin saber qué viaje es, no se ofrece ningún "previsto" de ella).
      const hn = norm(g.raw || "");
      const known = g.dir != null && !!stopPlan && stopPlan.pats.some((pt) => pt.l === g.linea && pt.s === g.dir && pt.h && pt.h.some((x) => norm(x) === hn));
      if (known) covered.add(`${g.linea}|${g.dir}|${hn}`);
      else if (g.dir != null) covered.add(`${g.linea}|${g.dir}`);
      else if (lines && lines[g.linea]) lines[g.linea].sentidos.forEach((_, i) => covered.add(`${g.linea}|${i}`));
      // Retraso: frente a los viajes del horario con su mismo letrero (si los hay; si no, la línea y sentido).
      const all = g.dir != null ? passesOf.get(`${g.linea}|${g.dir}`) || [] : [];
      const rn = norm(g.raw || "");
      const same = all.filter((p) => { const h = stopPlan.pats[p.pat].h; return h && h.some((x) => norm(x) === rn); });
      const ps = same.length ? same : all;
      const delay = ps.length ? delayOf(ps, nowS + mins[0] * 60, new Set()) : null;
      rows.push({ live: true, linea: g.linea, ruta: g.ruta, raw: g.raw, sortMin: mins[0], mins, delay });
    }
    // Según horario (19): por línea, sentido y letrero de cada viaje (67: un ramal o un viaje que
    // "remata" antes sale con su propio letrero y sus horas, nunca con el destino de otro), sin los
    // que ya tienen un bus en vivo.
    const headOf = (p) => {
      const pt = stopPlan.pats[p.pat];
      if (pt.h && pt.h.length === 1) return pt.h[0];
      const last = byId.get(stopPlan.ids[pt.p[pt.p.length - 1]]);   // varios letreros: "Hasta <su última parada>"
      return last ? untilLabel(last.name) : "";
    };
    const schedOf = new Map();
    for (const [k, ps] of passesOf) {
      if (covered.has(k)) continue;
      ps.forEach((p) => {
        const h = headOf(p), key = `${k}|${norm(h)}`;
        if (covered.has(key)) return;
        if (!schedOf.has(key)) schedOf.set(key, { h, ps: [] });
        schedOf.get(key).ps.push(p);
      });
    }
    for (const { h, ps } of schedOf.values()) {
      const next = ps.filter((p) => p.at >= nowS - 30 && p.at <= nowS + SCHED_AHEAD);
      if (!next.length) continue;
      const [linea, dir] = [next[0].line, next[0].dir];
      const ln = lines && lines[linea];
      const ruta = h ? headText(h) : ln && ln.sentidos[dir] ? ln.sentidos[dir].destino : "";
      rows.push({ live: false, linea, ruta, raw: UNTIL.has(h) ? "" : h, sortMin: (next[0].at - nowS) / 60, at: next.map((p) => p.at) });
    }
    rows.sort((a, b) => a.sortMin - b.sortMin);

    const err = list == null && s ? `<div class="state"><strong>${esc(t("times_error"))}</strong>
        ${esc(t("times_error_body", { infobus: "\u0000" })).replace("\u0000",
          `<a href="${INFOBUS_URL(s.id)}" target="_blank" rel="noopener">Infobus</a>`)}</div>` : "";
    if (!rows.length) {
      box.innerHTML = err || `<div class="state"><strong>${esc(t("empty"))}</strong> ${esc(t("empty_body"))}</div>`;
      return;
    }
    const onlySched = !rows.some((r) => r.live);
    const head = err || (onlySched ? `<p class="note">${esc(t("sched_only"))}</p>` : "");
    box.innerHTML = head + rows.map((g) => {
      let eta, sub;
      if (g.live) {
        const m = g.mins[0];
        eta = m <= 0 ? `<span class="eta now"><b>${esc(t("arriving"))}</b></span>`
                     : `<span class="eta">${etaNum(m)}</span>`;
        sub = delayHtml(g.delay) + (g.mins[1] != null ? `<small>${esc(t("next", { n: g.mins[1] }))}</small>` : "");
      } else {
        // Según horario: "previsto" y los minutos que faltan, en naranja (mockup 4).
        const m = Math.max(0, Math.round(g.sortMin));
        eta = `<span class="eta sched"><small>${esc(t("sched_word"))}</small>${etaNum(m)}</span>`;
        sub = `<small class="sched-tag">${esc(t("sched_sub"))}${g.at[1] != null ? ` · ${esc(t("then_at", { time: hhmm(g.at[1]) }))}` : ""}</small>`;
      }
      // Toda la fila (número, destino y tiempo) abre la línea en el mapa.
      const known = lines && lines[g.linea];
      const tag = known ? "button" : "div";
      const attrs = known ? ` type="button" data-line="${esc(g.linea)}" data-ruta="${esc(g.ruta)}"${g.raw ? ` data-raw="${esc(g.raw)}"` : ""} title="${esc(t("see_line", { code: g.linea }))}"` : "";
      return `<${tag} class="arrival${g.live ? "" : " is-sched"}"${attrs}>
        <span class="badge"${lineStyle(g.linea)}>${esc(g.linea)}</span>
        <span class="route"><b>${esc(g.ruta)}</b>${sub}</span>
        ${eta}
      </${tag}>`;
    }).join("");
  }

  // ---------- Horarios de una parada (12 y 13) ----------
  // Los publicados por Vitrasa (data/viajes.json): por línea y sentido, primer y último paso,
  // frecuencia aproximada y todas las horas. Pestañas: laborable, sábado y domingo/festivo.
  let sched = null;   // { id, day, line: null | código }
  const HOLI = (d) => PLAN.isHoliday(d);
  // Tipo de día de hoy: "w" laborable, "6" sábado, "0" domingo o festivo.
  const todayType = (d = new Date()) => (HOLI(d) || d.getDay() === 0 ? "0" : d.getDay() === 6 ? "6" : "w");
  // Bit de los viajes de ese tipo de día: el laborable, el de hoy si lo es (y si no, el miércoles).
  const typeBit = (ty) => (ty === "w" ? 1 << (todayType() === "w" ? new Date().getDay() : 3) : 1 << Number(ty));
  const hhmm = (sec) => `${String(Math.floor(sec / 3600) % 24).padStart(2, "0")}:${String(Math.floor(sec / 60) % 60).padStart(2, "0")}`;
  function everyText(times) {
    // Mediana del tiempo entre pasos de 7 a 21 h (o del día entero, si no hay bastantes).
    const gaps = (ts) => ts.slice(1).map((x, i) => x - ts[i]).sort((a, b) => a - b);
    let g = gaps(times.filter((x) => x >= 7 * 3600 && x <= 21 * 3600));
    if (g.length < 2) g = gaps(times);
    if (!g.length) return "";
    const m = Math.max(1, Math.round(g[g.length >> 1] / 60));
    return m < 60 ? t("every_min", { n: m }) : m % 60 ? t("every_h", { h: Math.floor(m / 60), m: m % 60 }) : t("every_h0", { h: m / 60 });
  }
  function showSched(id, line = null) {
    const s = byId.get(id);
    leaveStop();
    clearLine();
    showView("sched");
    if (!sched || sched.id !== id || sched.line !== line) sched = { id, day: sched && sched.id === id ? sched.day : todayType(), line };
    document.title = `${t("sched_title")}${line ? ` · ${line}` : ""} · ${s.name} · ${APP_NAME}`;
    panel.dataset.screen = "sched";
    $("#sched-meta").textContent = `${line ? `${t("line_n", { code: line })} · ` : ""}${s.name} · ${t("stop_lc", { id })}`;
    if (!isDesktop()) panel.dataset.state = "full";
    selRing.setLatLng(s.ll).addTo(map);
    renderSched();
  }
  function renderSched() {
    if (!sched) return;
    document.querySelectorAll("#sched-days [data-day]").forEach((b) => b.setAttribute("aria-selected", b.dataset.day === sched.day));
    const box = $("#sched-list");
    box.innerHTML = `<p class="note">${esc(t("sched_loading"))}</p>`;
    const want = sched.id;
    Promise.all([PLAN.load(), linesReady]).then(([plan]) => {
      if (!sched || sched.id !== want || $("#sched").hidden) return;
      const si = plan.index.get(want);
      const passes = si == null ? [] : plan.stopPasses(si, typeBit(sched.day));
      // Líneas y sentidos que pasan por la parada algún día (para decir "no pasa" en los demás).
      const all = new Map();
      if (si != null) for (const [n, k] of plan.at[si]) { const pt = plan.pats[n]; if (k < pt.p.length - 1) all.set(`${pt.l}|${pt.s}`, { line: pt.l, dir: pt.s, times: [] }); }
      // Cada hora con el letrero de su viaje (67): para ver por separado ramales y viajes que "rematan".
      const headOf = (p) => { const pt = plan.pats[p.pat]; if (pt.h && pt.h.length === 1) return pt.h[0]; const last = byId.get(plan.ids[pt.p[pt.p.length - 1]]); return last ? untilLabel(last.name) : ""; };
      passes.forEach((p) => { const g = all.get(`${p.line}|${p.dir}`); g.times.push(p.t); (g.heads = g.heads || []).push(headOf(p)); });
      const order = Object.keys(lines || {});
      const groups = [...all.values()].filter((g) => !sched.line || g.line === sched.line).sort((a, b) => (!a.times.length - !b.times.length) || order.indexOf(a.line) - order.indexOf(b.line) || a.dir - b.dir);
      const date = new Date(`${plan.fecha}T12:00:00`).toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" });
      const nowS = (Date.now() - dayBase(new Date())) / 1000;
      const isToday = sched.day === todayType();
      // Como en el mockup (9): una tarjeta por línea y sentido (la primera abierta) con todas las
      // horas del día en una cuadrícula; la próxima, resaltada.
      let opened = false;
      const html = groups.map((g) => {
        const ln = lines && lines[g.line];
        const dest = ln && ln.sentidos[g.dir] ? ln.sentidos[g.dir].destino : "";
        const head = `<span class="badge"${lineStyle(g.line)}>${esc(g.line)}</span><span class="what"><b>${esc(dest)}</b>`;
        if (!g.times.length) return `<div class="sched-card off"><div class="sc-head">${head}<small>${esc(t("no_service"))}</small></span></div></div>`;
        // Letreros de esta línea y sentido: el principal (el de más viajes) y los demás (ramales y
        // viajes que acaban antes), con un botón cada uno; en "Todos", los demás llevan una letra.
        const cnt = new Map();
        g.heads.forEach((h) => cnt.set(norm(h), { h, n: ((cnt.get(norm(h)) || {}).n || 0) + 1 }));
        const hs = [...cnt.entries()].sort((a, b) => b[1].n - a[1].n);
        const key = `${g.line}|${g.dir}`;
        let pick = schedPick.get(key) || "";
        if (pick && !cnt.has(pick)) pick = "";
        const letter = new Map(hs.slice(1).map(([k], i) => [k, "abcdefgh"[i] || "*"]));
        const idx = g.times.map((_, i) => i).filter((i) => !pick || norm(g.heads[i]) === pick);
        const ts = idx.map((i) => g.times[i]);
        const meta = ts.length ? [t("first_last", { first: hhmm(ts[0]), last: hhmm(ts[ts.length - 1]) }), everyText(ts)].filter(Boolean).join(" · ") : "";
        const nextJ = isToday ? ts.findIndex((x) => x >= nowS - 60) : -1;
        const cells = idx.map((i, j) => {
          const x = g.times[i], lt = !pick && letter.get(norm(g.heads[i]));
          return `<span class="${j === nextJ ? "next" : isToday && x < nowS - 60 ? "past" : ""}">${hhmm(x)}${lt ? `<sup>${lt}</sup>` : ""}</span>`;
        }).join("");
        const nextI = nextJ;
        const chips = hs.length > 1 ? `<div class="sc-heads" data-key="${esc(key)}">${[["", t("lines_all")], ...hs.map(([k, v]) => [k, headText(v.h)])]
          .map(([k, txt]) => `<button type="button" data-head="${esc(k)}" aria-pressed="${k === pick}">${k && letter.get(k) ? `<sup>${letter.get(k)}</sup> ` : ""}${esc(txt)}</button>`).join("")}</div>` : "";
        // Con un letrero elegido, el título de la tarjeta es ese letrero.
        const headSel = pick ? `<span class="badge"${lineStyle(g.line)}>${esc(g.line)}</span><span class="what"><b>${esc(headText(cnt.get(pick).h))}</b>` : head;
        const legend = !pick && letter.size ? `<p class="sched-legend">${[...letter].map(([k, lt]) => `<sup>${lt}</sup> ${esc(headText(cnt.get(k).h))}`).join(" · ")}</p>` : "";
        const open = sched.line || !opened || schedPick.has(key);
        opened = true;
        return `<details class="sched-card"${open ? " open" : ""}><summary class="sc-head">${headSel}<small>${esc(meta)}</small></span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></summary>
          ${chips}<div class="sched-times">${cells}</div>${legend}${isToday && nextI >= 0 ? `<p class="sched-hint">${esc(t("sched_hint"))}</p>` : ""}</details>`;
      }).join("");
      box.innerHTML = (html || `<div class="state"><strong>${esc(t("sched_none"))}</strong></div>`) +
        `<p class="note">${esc(t("sched_note", { date }))}</p>`;
      box.querySelectorAll("details.sched-card[open]").forEach(scrollToNext);
    }).catch(() => { if (sched && sched.id === want) box.innerHTML = `<div class="state"><strong>${esc(t("sched_error"))}</strong></div>`; });
  }
  // Cuadrícula de horas: que se vea la próxima (con una fila de antes).
  function scrollToNext(d) {
    const box = d.querySelector(".sched-times"), nx = box && box.querySelector(".next");
    if (nx) box.scrollTop = Math.max(0, nx.offsetTop - box.offsetTop - 38);
  }
  // Letrero elegido en cada tarjeta de horarios (línea|sentido → letrero normalizado; "" = todos).
  const schedPick = new Map();
  $("#sched-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-head]");
    if (!b) return;
    e.preventDefault();
    schedPick.set(b.closest(".sc-heads").dataset.key, b.dataset.head);
    renderSched();
  });
  $("#sched-list").addEventListener("toggle", (e) => { if (e.target.open) scrollToNext(e.target); }, true);
  $("#sched-days").addEventListener("click", (e) => {
    const b = e.target.closest("[data-day]");
    if (!b || !sched || b.dataset.day === sched.day) return;
    sched.day = b.dataset.day;
    renderSched();
  });
  $("#sched-open").addEventListener("click", () => { if (current) navigate(`horario/${current.id}`); });
  // Horarios de la línea abierta: en la parada desde la que se abrió o, si no, desde la cabecera
  // del sentido que se ve.
  $("#line-sched").addEventListener("click", () => {
    if (!active) return;
    const stop = active.from || lines[active.code].sentidos[active.dir].paradas[0];
    if (stop) navigate(`horario/${stop}/${encodeURIComponent(active.code)}${active.variant ? `/${encodeURIComponent(active.variant.ruta)}` : ""}`);
  });
  $("#sched-back").addEventListener("click", goBack);


  function refreshNearDep() {
    clearTimeout(nearTimer);
    const box = document.querySelector(".near-dep-list");
    if (!box || !me || mode !== "near" || $("#home").hidden) return;
    if (document.hidden) { nearTimer = setTimeout(refreshNearDep, REFRESH_MS); return; }
    const near = nearest(me, 12).filter(({ d }) => d <= NEAR_DEP_M).slice(0, 6);
    if (!near.length) { box.innerHTML = `<p class="note">${esc(t("near_dep_none_stops"))}</p>`; return; }
    Promise.all(near.map(({ s }) => getLive(s.id))).then((res) => {
      const box2 = document.querySelector(".near-dep-list");
      if (!box2) return;
      const rows = [];
      res.forEach((e, k) => {
        if (!e.list) return;
        const { s, d } = near[k];
        const walk = walkMin(d * 1.25);
        const seen = new Set();
        e.list.forEach((x) => {
          const m = Number(x.minutos) - Math.round((Date.now() - e.at) / 60000);
          const code = normLine(x.linea), raw = String(x.ruta || "").trim();
          if (isNaN(m) || m < walk - 1) return;   // no da tiempo a llegar andando
          const key = `${code}|${norm(raw)}`;
          if (seen.has(key)) return;              // de cada línea y letrero, el próximo en esa parada
          seen.add(key);
          rows.push({ code, raw, ruta: titleCase(raw), m, s, walk, d });
        });
      });
      // De cada línea y letrero, solo en la parada donde sale antes.
      rows.sort((a, b) => a.m - b.m || a.walk - b.walk);
      const once = new Set();
      const top = rows.filter((r) => { const k = `${r.code}|${norm(r.raw)}`; if (once.has(k)) return false; once.add(k); return true; }).slice(0, NEAR_DEP_MAX);
      box2.innerHTML = top.length ? top.map((r) => {
        const eta = r.m <= 0 ? `<span class="eta now"><b>${esc(t("arriving"))}</b></span>` : `<span class="eta">${etaNum(r.m)}</span>`;
        const known = lines && lines[r.code];
        return `<${known ? "button" : "div"} class="arrival"${known ? ` type="button" data-near-line="${esc(r.code)}" data-near-stop="${esc(r.s.id)}" data-near-raw="${esc(r.raw)}"` : ""}>
          <span class="badge"${lineStyle(r.code)}>${esc(r.code)}</span>
          <span class="route"><b>${esc(r.ruta)}</b><small>${esc(r.s.name)} · ${esc(fmtDist(r.d))}</small></span>${eta}
        </${known ? "button" : "div"}>`;
      }).join("") : `<p class="note">${esc(t("near_dep_none"))}</p>`;
    });
    nearTimer = setTimeout(refreshNearDep, REFRESH_MS);
  }
  // Tocar uno: esa línea (solo los viajes con ese letrero) desde su parada.
  $("#list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-near-line]");
    if (!b) return;
    e.stopPropagation();
    navigate(`linea/${b.dataset.nearLine}/${b.dataset.nearStop}${b.dataset.nearRaw ? `/${encodeURIComponent(b.dataset.nearRaw)}` : ""}`);
  }, true);

  // ---------- Pestaña Favoritas (5) ----------
  const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z"/></svg>';
  const EDIT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';
  let favTimer = null;
  let favPicking = null;          // "home" | "work" mientras se elige con el buscador del propio botón
  const favOpenLines = new Set(); // paradas con el selector de líneas abierto
  // Favoritas como en el mockup (rediseño): casa y trabajo en tarjetas sobre la cabecera roja y,
  // en la hoja, Paradas (tarjeta con los tiempos de sus líneas), Trayectos y Sitios.
  const HW_ICON = {
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/></svg>',
    work: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 13h18"/></svg>',
  };
  const CHEV_R = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  function renderHw() {
    const box = $("#screen-extra");
    box.className = "screen-extra hw-row";
    box.dataset.kind = "fav";
    box.innerHTML = ["home", "work"].map((k) => {
      const p = favs[k];
      return `<div class="hw-card"><button type="button" class="hw-go" ${p ? `data-hwgo="${k}"` : `data-pick="${k}"`}>
          <span class="hw-ico">${HW_ICON[k]}</span>
          <span class="hw-txt"><b>${esc(t(p ? `go_${k}` : `set_${k}`))}</b><small data-hweta="${k}">${p && hwEtaCache[k] && hwEtaCache[k].html ? hwEtaCache[k].html : esc(p ? p.label : t("set_hint"))}</small></span></button>
        ${p ? `<button type="button" class="hw-edit" data-pick="${k}" aria-label="${esc(t(`change_${k}`))}" title="${esc(t(`change_${k}`))}">${EDIT_SVG}</button>` : ""}</div>`;
    }).join("");
  }
  // Casa y trabajo (64, mockup 6): debajo, cuánto se tarda ahora desde tu ubicación con la mejor
  // opción ("27 min · A en 4 min", según horario) o andando si es más rápido. Sin tu ubicación, la dirección.
  const hwEtaCache = {};
  async function hwEta(k) {
    const p = favs[k];
    if (!p || !me || farFromVigo(me)) return;
    const key = `${fmtLL(me)}>${fmtLL(p.ll)}`;
    const c = hwEtaCache[k];
    if (c && c.key === key && Date.now() - c.at < 60000) return;
    hwEtaCache[k] = { key, at: Date.now(), html: c && c.key === key ? c.html : "" };
    try {
      const [net, plan] = await Promise.all([window.PV_PEATON.load(), PLAN.load(), linesReady]);
      if (tripOpen()) return;   // no tocar la red mientras se calcula un viaje
      const start = new Date();
      setVerticalTime(net, start);
      const r = net.route(me, p.ll);
      const walkEq = r ? r.eq + r.offFrom + r.offTo : Infinity;
      const origins = stopsAround(net, plan, me), dests = stopsAround(net, plan, p.ll, undefined, true);
      const cands = plan.search({ origins, dests, walk: walkEq, maxTransfers: 2, prefer: "fast", originsMech: origins.mech, destsMech: dests.mech, time: start });
      const opts = plan.choose(cands, start, walkEq);
      const nowS = (Date.now() - dayBase(start).getTime()) / 1000;
      const j = opts[0];
      const busMin = j ? (j.arr - Math.max(j.dep, nowS)) / 60 : Infinity;
      const walkM = walkEq < Infinity ? walkMin(walkEq) : Infinity;
      let html;
      if (walkM <= busMin && walkM < Infinity) html = `${esc(hMin(walkM))} ${esc(t("on_foot_lc"))}`;
      else if (j) {
        const first = j.legs.find((l) => l.type === "bus");
        const wait = Math.max(0, Math.round((first.dep - nowS) / 60));
        html = `${esc(hMin(Math.max(1, Math.round(busMin))))} · <i class="hb"${lineStyle(first.line)}>${esc(first.line)}</i> + ${esc(hMin(wait))}`;   // como en el mockup: "27 min · A + 4 min" (sale en 4 min)
      } else return;
      hwEtaCache[k].html = html;
      const el = document.querySelector(`[data-hweta="${k}"]`);
      if (el) el.innerHTML = html;
    } catch { /* sin red o sin horarios: se queda la dirección */ }
  }
  function refreshHwEta() {
    if (mode !== "fav") return;
    const go = () => ["home", "work"].forEach((k) => hwEta(k));
    if (me) go(); else if (navigator.permissions && navigator.permissions.query) {
      // Solo si ya se dio permiso: no se pide la ubicación por abrir Favoritas.
      navigator.permissions.query({ name: "geolocation" }).then((st) => { if (st.state === "granted") getPosition(() => { if (mode === "fav") renderHw(); go(); }, () => {}); }).catch(() => {});
    }
  }
  // Nombres útiles en favoritas (64): un punto del mapa o "aquí" se guarda con el portal más cercano
  // (a menos de 40 m) o, si no hay, con sus coordenadas. Las guardadas antes con "Punto del mapa" o
  // "Aquí (mi ubicación actual)" se arreglan solas la primera vez que se abren las Favoritas.
  function placeName(ll) {
    const a = nearestAddr(ll);
    return a ? a.label : `${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}`;
  }
  const VAGUE = new Set(Object.values(I18N.dict).flatMap((d) => [d.map_point, d.saved_here]).filter(Boolean));
  let favNamesFixed = false;
  function fixFavNames() {
    if (favNamesFixed) return;
    const bad = (x) => x && VAGUE.has(x);
    const todo = favs.trips.some((f) => bad(f.al) || bad(f.bl)) || ["home", "work"].some((k) => favs[k] && bad(favs[k].label)) || favs.places.some((p) => bad(p.label));
    favNamesFixed = true;
    if (!todo) return;
    ensureDir().then(() => {
      favs.trips.forEach((f) => {
        if (bad(f.al)) { const p = parseEnd(f.a); if (p) f.al = placeName(p.ll); }
        if (bad(f.bl)) { const p = parseEnd(f.b); if (p) f.bl = placeName(p.ll); }
      });
      ["home", "work"].forEach((k) => { if (favs[k] && bad(favs[k].label)) favs[k].label = placeName(favs[k].ll); });
      favs.places.forEach((p) => { if (bad(p.label)) p.label = placeName(p.ll); });
      saveFavs();
      if (mode === "fav" && panel.dataset.view === "home") renderFav();
    }).catch(() => { favNamesFixed = false; });
  }
  function renderFav() {
    clearTimeout(favTimer);
    fixFavNames();
    renderHw();
    refreshHwEta();
    const items = [];
    const head = (k) => { const li = document.createElement("li"); li.className = "sec-head"; li.textContent = t(k); return li; };
    if (favPicking) items.push(pickerItem());
    // Paradas: tarjeta con los tiempos en vivo de sus líneas (todas o las elegidas).
    const st = favs.stops.filter((f) => byId.has(f.id));
    if (st.length) items.push(head("fav_stops"));
    st.forEach((f) => {
      const s = byId.get(f.id);
      const n = f.lines ? f.lines.length : 0;
      const li = document.createElement("li");
      li.className = "fav-card";
      li.innerHTML = `<div class="fc-top"><button type="button" class="fc-open" data-id="${esc(s.id)}">
          <span class="name">${esc(s.name)}</span>
          <span class="sub">${esc(t("stop_n", { id: s.id }))} · ${esc(n ? t(n === 1 ? "fav_sel_1" : "fav_sel_n", { n }) : t("fav_sel_all"))}</span></button>
        <button type="button" class="pill" data-flines="${esc(f.id)}" aria-expanded="${favOpenLines.has(f.id)}">${esc(t("tab_lines"))}</button></div>
        <div class="fav-live" data-live="${esc(f.id)}">…</div>`;
      if (favOpenLines.has(f.id)) {
        const pick = document.createElement("div");
        pick.className = "fav-linepick lines";
        pick.innerHTML = s.lines.map((code) => `<button type="button" class="chip" data-fl="${esc(code)}" data-flstop="${esc(f.id)}" aria-pressed="${!f.lines || f.lines.includes(code)}"${lineStyle(code)}>${esc(code)}</button>`).join("");
        li.append(pick);
      }
      items.push(li);
    });
    // Trayectos guardados (37): A → B con sus líneas; tocar abre Cómo llegar con esa opción.
    if (favs.trips.length) items.push(head("fav_trips"));
    favs.trips.forEach((f, i) => {
      const li = document.createElement("li");
      li.className = "fav-row";
      const how = f.key === "walk" ? `<span class="what">${esc(t("on_foot"))}</span>` : f.lines.map(badge).join(CHEV);
      li.classList.add("fav-trip-row");
      li.innerHTML = `<button type="button" data-ftripfav="${i}">
        <span class="name">${esc(f.al || t("my_location"))} → ${esc(f.bl || t("my_location"))}</span>
        <span class="sub chain">${how}</span></button>
        <button type="button" class="fav-trip-del" aria-pressed="true" data-ftripdel="${i}" aria-label="${esc(t("trip_unfav"))}" title="${esc(t("trip_unfav"))}">${STAR_SVG}</button>`;
      items.push(li);
    });
    // Sitios y direcciones.
    if (favs.places.length) items.push(head("fav_places"));
    favs.places.forEach((p, i) => {
      const li = document.createElement("li");
      li.className = "fav-row";
      li.innerHTML = `<button type="button" data-fplace="${i}">
        <span class="name">${esc(p.label)}</span>
        <span class="sub">${esc(p.site ? t(`site_${p.site}`) : t("fav_address"))}</span>${CHEV_R}</button>`;
      items.push(li);
    });
    fillList(items, favs.stops.length || favs.places.length || favs.trips.length ? "" : t("no_favs"));
    if (favPicking) { const q = $("#fav-pick-q"); q.focus(); fillPicker(); }
    refreshFavLive();
  }
  // Tiempos en vivo de las paradas favoritas (cada 30 s mientras se ve la pestaña).
  function refreshFavLive() {
    clearTimeout(favTimer);
    if (mode !== "fav" || $("#home").hidden) return;
    favs.stops.forEach((f) => getLive(f.id).then((e) => {
      const box = document.querySelector(`.fav-live[data-live="${CSS.escape(f.id)}"]`);
      if (!box) return;
      if (!e.list) { box.textContent = t("times_error"); return; }
      const by = new Map();
      e.list.forEach((x) => {
        const code = normLine(x.linea), m = Number(x.minutos);
        if (isNaN(m) || (f.lines && !f.lines.includes(code))) return;
        if (!by.has(code)) by.set(code, []);
        by.get(code).push(m - Math.round((Date.now() - e.at) / 60000));
      });
      const rows = [...by].map(([code, ms]) => [code, ms.sort((a, b) => a - b).filter((m) => m >= 0).slice(0, 2)]).filter(([, ms]) => ms.length)
        .sort((a, b) => a[1][0] - b[1][0]);
      box.innerHTML = rows.length ? rows.map(([code, ms]) =>
        `<span class="fl"><i${lineStyle(code)}>${esc(code)}</i><b>${ms[0] <= 0 ? esc(t("arriving")) : esc(hMin(ms[0]))}</b></span>`).join("")
        : `<span class="fl-none">${esc(t(f.lines ? "fav_none_lines" : "bus_none"))}</span>`;
    }));
    favTimer = setTimeout(() => { if (!document.hidden) refreshFavLive(); }, REFRESH_MS);
  }
  // Buscador del botón "Elegir casa / trabajo".
  function pickerItem() {
    const li = document.createElement("li");
    li.className = "fav-picker";
    li.innerHTML = `<label class="visually-hidden" for="fav-pick-q">${esc(t(`set_${favPicking}`))}</label>
      <div class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>
      <input id="fav-pick-q" type="search" autocomplete="off" spellcheck="false" placeholder="${esc(t(`pick_${favPicking}`))}"></div>
      <ul id="fav-pick-res" class="stops"></ul>
      <button type="button" class="fav-cancel" data-pickcancel="1">${esc(t("cancel"))}</button>`;
    return li;
  }
  const pickBtn = (attrs, name, sub) => `<li><button type="button" ${attrs}><span class="name">${name}</span><span class="sub">${esc(sub)}</span></button></li>`;
  function fillPicker() {
    const box = $("#fav-pick-res");
    if (!box) return;
    const q = $("#fav-pick-q").value.trim();
    const out = [];
    const here = me && !farFromVigo(me) ? pickBtn('data-pk="me"', esc(t("my_location_now")), t("my_location")) : null;
    // Sin texto, "Mi ubicación" arriba; con texto, lo encontrado primero (como en Cómo llegar).
    if (here && !q) out.push(here);
    if (/\p{L}.*\p{L}.*\p{L}/u.test(q)) {
      const tokens = norm(q).split(" ").filter(Boolean);
      if (!sitesData) ensureSites().then(fillPicker).catch(() => {});
      if (!dirData) ensureDir().then(fillPicker).catch(() => {});
      matchSites(q, 4).forEach((s) => out.push(pickBtn(`data-pk="site" data-i="${s.i}"`, highlight(s.name, tokens), t(`site_${s.type}`))));
      if (dirData) {
        const p = dirData.parse(q);
        dirData.matchStreets(p.street, 4).forEach((st) => {
          const label = p.num ? `${st.name}, ${p.num}` : st.name;
          out.push(pickBtn(`data-pk="addr" data-i="${st.i}" data-num="${esc(p.num || "")}"`, highlight(label, tokens), p.num ? t("res_addr") : t("addr_add_num")));
        });
      }
      matchStops(q).slice(0, 4).forEach((s) => out.push(pickBtn(`data-pk="stop" data-i="${esc(s.id)}"`, highlight(s.name, tokens), t("stop_n", { id: s.id }))));
    }
    if (here && q) out.push(here);
    box.innerHTML = out.join("");
  }
  // Tecla "Buscar"/Intro: elige el primer resultado (si aún se están cargando las direcciones o
  // los sitios, espera a que lleguen). Una calle sin número completa "Calle, " para escribirlo.
  async function pickFirst() {
    const q = $("#fav-pick-q");
    if (!q || !q.value.trim()) return;
    if (/\p{L}.*\p{L}.*\p{L}/u.test(q.value)) {
      await Promise.all([sitesData ? null : ensureSites().catch(() => {}), dirData ? null : ensureDir().catch(() => {})]);
      fillPicker();
    }
    const first = $("#fav-pick-res button[data-pk]:not([data-pk=\"me\"])");
    if (first) first.click();
  }
  function savePick(p) {
    if (document.activeElement) document.activeElement.blur();
    favs[favPicking] = p;
    saveFavs();
    toast(t(`saved_${favPicking}`));
    favPicking = null;
    renderFav();
  }
  // Abrir un trayecto guardado: sus extremos (con tu ubicación de ahora si era "Mi ubicación") y,
  // si esa combinación de líneas sale, se destaca y se dibuja (trip.want).
  function openFavTrip(f) {
    trip.a = trip.b = null;
    trip.sel = null;
    trip.want = { a: f.a, b: f.b, key: f.key };
    const meEnd = me && !farFromVigo(me) ? { kind: "me", ll: me } : null;
    trip.a = f.a ? parseEnd(decodeURIComponent(f.a)) : meEnd;
    trip.b = f.b ? parseEnd(decodeURIComponent(f.b)) : meEnd;
    navigate(`ir/${endToken(trip.a)}/${endToken(trip.b)}`);
    const w = !f.a ? "a" : !f.b ? "b" : null;
    if (w && !trip[w]) getPosition((ll) => { if (tripOpen() && !trip[w]) setEnd(w, { kind: "me", ll }); }, () => {});
  }
  // Ir a casa o al trabajo: Cómo llegar desde tu ubicación (si se puede) hasta allí.
  function goTo(p) {
    trip.a = trip.b = null;
    trip.sel = null;
    trip.b = { kind: "addr", ll: p.ll, label: p.label };
    if (me && !farFromVigo(me)) trip.a = { kind: "me", ll: me };
    navigate(`ir/${endToken(trip.a)}/${endToken(trip.b)}`);
    if (!trip.a) getPosition((ll) => { if (tripOpen() && !trip.a) setEnd("a", { kind: "me", ll }); }, () => {});
  }
  $("#list").addEventListener("input", (e) => { if (e.target.id === "fav-pick-q") fillPicker(); });
  // En el móvil, al escribir, el panel sube a pantalla completa con el buscador arriba: si no, los
  // resultados quedaban debajo del teclado y parecía que no buscaba.
  $("#list").addEventListener("focusin", (e) => {
    if (e.target.id !== "fav-pick-q" || isDesktop()) return;
    panel.dataset.state = "full";
    panel.classList.add("fav-picking");   // oculta el buscador principal, las pestañas y casa/trabajo
    $("#list").scrollTop = 0;
  });
  $("#list").addEventListener("focusout", (e) => {
    if (e.target.id !== "fav-pick-q") return;
    // Tocar un resultado quita el foco un instante antes del clic: se espera para no mover nada.
    setTimeout(() => { if (document.activeElement !== $("#fav-pick-q")) panel.classList.remove("fav-picking"); }, 200);
  });
  $("#list").addEventListener("keydown", (e) => {
    if (e.target.id !== "fav-pick-q") return;
    if (e.key === "Enter") { e.preventDefault(); pickFirst(); }
    if (e.key === "Escape") { favPicking = null; renderFav(); }
  });
  $("#screen-extra").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || mode !== "fav") return;
    if (b.dataset.pick) { favPicking = favPicking === b.dataset.pick ? null : b.dataset.pick; renderFav(); return; }
    if (b.dataset.hwgo) goTo(favs[b.dataset.hwgo]);
  });
  $("#list").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || mode !== "fav") return;
    if (b.dataset.pick) { e.stopPropagation(); favPicking = favPicking === b.dataset.pick ? null : b.dataset.pick; renderFav(); return; }
    if (b.dataset.pickcancel) { e.stopPropagation(); favPicking = null; renderFav(); return; }
    if (b.dataset.go) { e.stopPropagation(); goTo(favs[b.dataset.go]); return; }
    if (b.dataset.pk) {
      e.stopPropagation();
      const k = b.dataset.pk;
      if (k === "me") { const ll = me.slice(); ensureDir().catch(() => {}).then(() => savePick({ ll, label: placeName(ll) })); }
      else if (k === "site") { const s = sitesData[Number(b.dataset.i)]; savePick({ ll: s.ll, label: s.name, site: s.type }); }
      else if (k === "stop") { const s = byId.get(b.dataset.i); savePick({ ll: s.ll, label: s.name }); }
      else if (k === "addr") {
        const st = dirData.streets[Number(b.dataset.i)];
        if (!b.dataset.num) { const q = $("#fav-pick-q"); q.value = `${st.name}, `; q.focus(); fillPicker(); return; }
        const r = dirData.resolve(st, b.dataset.num);
        savePick({ ll: r.ll, label: `${st.name}, ${b.dataset.num}` });
      }
      return;
    }
    if (b.dataset.flines) {
      e.stopPropagation();
      const id = b.dataset.flines;
      if (favOpenLines.has(id)) favOpenLines.delete(id); else favOpenLines.add(id);
      renderFav();
      return;
    }
    if (b.dataset.fl) {
      e.stopPropagation();
      const f = favStop(b.dataset.flstop), s = byId.get(f.id);
      const on = new Set(f.lines || s.lines);
      if (on.has(b.dataset.fl)) on.delete(b.dataset.fl); else on.add(b.dataset.fl);
      f.lines = on.size === s.lines.length || !on.size ? null : s.lines.filter((c) => on.has(c));
      saveFavs();
      renderFav();
      return;
    }
    if (b.dataset.fplace) { e.stopPropagation(); const p = favs.places[Number(b.dataset.fplace)]; openPlace({ ll: p.ll, label: p.label, approx: false, site: p.site }); return; }
    if (b.dataset.ftrip) { e.stopPropagation(); goTo(favs.places[Number(b.dataset.ftrip)]); }
    if (b.dataset.ftripfav) { e.stopPropagation(); openFavTrip(favs.trips[Number(b.dataset.ftripfav)]); return; }
    if (b.dataset.ftripdel) {
      e.stopPropagation();
      favs.trips.splice(Number(b.dataset.ftripdel), 1);
      saveFavs();
      toast(t("trip_unfaved"));
      renderFav();
      return;
    }
  }, true);
  // Estrella en la ficha de una dirección o de un sitio.
  function updatePlaceFav() {
    const on = !!(place && favPlace(place));
    const b = $("#place-fav");
    b.setAttribute("aria-pressed", on);
    b.setAttribute("aria-label", on ? t("fav_remove") : t("fav_add"));
  }
  $("#place-fav").addEventListener("click", () => {
    if (!place) return;
    if (favPlace(place)) favs.places = favs.places.filter((f) => placeKey(f) !== placeKey(place));
    else favs.places.push({ ll: place.ll.slice(), label: place.label, ...(place.site ? { site: place.site } : {}) });
    saveFavs();
    updatePlaceFav();
    toast(favPlace(place) ? t("fav_added") : t("fav_removed"));
  });

  // ---------- Dirección (calle y número) ----------
  // En la dirección web: #dir/<lat,lon>~<Calle, número>[~a] ("~a": posición aproximada).
  const PIN_SVG = '<svg viewBox="0 0 34 44" aria-hidden="true"><path d="M17 42s-14-13.2-14-24.5a14 14 0 0 1 28 0C31 28.8 17 42 17 42z" fill="#D3202F" stroke="#fff" stroke-width="2.5"/><circle cx="17" cy="17.5" r="5" fill="#fff"/></svg>';
  const placeIcon = L.divIcon({ className: "place-pin", html: PIN_SVG, iconSize: [34, 44], iconAnchor: [17, 42] });
  let placeMarker = null;
  let place = null;   // { ll, label, approx }

  const placeToken = (p) => `dir/${fmtLL(p.ll)}~${encodeURIComponent(p.label)}${p.approx ? "~a" : p.site ? `~s-${p.site}` : ""}`;
  function openPlace(p, { replace = false } = {}) { navigate(placeToken(p), { replace }); }

  function showPlace(tok) {
    const parts = location.hash.slice(1).split("/").slice(1).join("/").split("~").map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
    const m = (parts[0] || "").match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (!m || !parts[1]) return false;
    leaveStop();
    clearLine();
    const site = parts[2] && parts[2].startsWith("s-") ? parts[2].slice(2) : null;
    const next = { ll: [Number(m[1]), Number(m[2])], label: parts[1], approx: parts[2] === "a", site };
    const same = place && placeToken(place) === placeToken(next);   // p. ej., al cambiar de idioma
    showView("place");
    place = next;
    document.title = `${place.label} · ${APP_NAME}`;
    $("#place-name").textContent = place.label;
    updatePlaceFav();
    // Como en el mockup (10): "Dirección · a 650 m de ti" y las paradas de alrededor con sus líneas.
    $("#place-meta").textContent = place.site ? t(`site_${place.site}`) : place.approx ? t("addr_approx") : /\d/.test(place.label) ? t("fav_address") : t("addr_whole");
    $("#place-dist").textContent = me ? ` · ${t("from_you", { d: fmtDist(haversine(me, place.ll)) })}` : "";
    $("#place-stops").replaceChildren(...nearest(place.ll, 6).map(({ s, d }) => {
      const li = document.createElement("li");
      li.innerHTML = `<button type="button" class="pstop" data-id="${esc(s.id)}">
        <span class="txt"><span class="name">${esc(s.name)}</span><span class="pl"><small>${esc(t("stop_n", { id: s.id }))}</small>${s.lines.map((l) => `<i${lineStyle(l)}>${esc(l)}</i>`).join("")}</span></span>
        <span class="walk"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13" cy="4" r="2"/><path d="M9 21l3-7 3 3v4M7 12l3-4 4 2 3 3"/></svg>${esc(hMin(walkMin(d * 1.25)))}</span>
      </button>`;
      return li;
    }));
    if (!placeMarker) placeMarker = L.marker(place.ll, { icon: placeIcon, keyboard: false, interactive: false, zIndexOffset: 1200 });
    placeMarker.setLatLng(place.ll).addTo(map);
    if (!same) {
      if (!isDesktop()) panel.dataset.state = "stop";
      focusOn(place.ll, Math.max(map.getZoom(), PLACE_ZOOM));
    }
    drawNums();
    return true;
  }
  function leavePlace() {
    if (!place) return;
    place = null;
    if (placeMarker) placeMarker.remove();
    drawNums();
  }
  $("#place-back").addEventListener("click", goBack);

  // ---------- Compartir ----------
  // Enlace a lo que se ve (parada, línea, dirección o trayecto). En el móvil se abre el menú de
  // compartir del teléfono; en el ordenador (o si no hay menú) se copia el enlace.
  // "Mi ubicación" nunca va en el enlace: esa parte se deja vacía para quien lo abra.
  const shareEnd = (p) => (p && p.kind !== "me" ? endToken(p) : "");
  function shareData(ctx) {
    const base = location.origin + location.pathname;
    if (ctx === "stop" && current) {
      return { url: `${base}#${current.id}`, text: `${current.name} · ${t("stop_n", { id: current.id })}` };
    }
    if (ctx === "line" && active) {
      const l = lines[active.code];
      const v = active.from && active.variant ? `/${encodeURIComponent(active.variant.ruta)}` : "";
      return { url: `${base}#linea/${encodeURIComponent(active.code)}${active.from ? `/${active.from}` : ""}${v}`,
        text: `${t("line_n", { code: active.code })} · ${active.variant ? t("towards", { dest: titleCase(active.variant.ruta) }) : l.nombre}` };
    }
    if (ctx === "place" && place) return { url: `${base}#${placeToken(place)}`, text: place.label };
    if (ctx === "sched" && sched) {
      const s = byId.get(sched.id);
      return { url: `${base}#horario/${sched.id}${sched.line ? `/${encodeURIComponent(sched.line)}` : ""}`,
        text: `${t("sched_title")}${sched.line ? ` · ${t("line_n", { code: sched.line })}` : ""} · ${s.name} · ${t("stop_n", { id: sched.id })}` };
    }
    if (ctx === "trip") {
      const a = shareEnd(trip.a), b = shareEnd(trip.b);
      if (!a && !b) return null;
      const la = a ? endLabel(trip.a) : "", lb = b ? endLabel(trip.b) : "";
      const text = a && b ? `${t("trip_title")}: ${la} → ${lb}` : b ? t("share_to", { to: lb }) : t("share_from", { from: la });
      return { url: `${base}#${`ir/${a}/${b}`.replace(/\/+$/, "")}`, text };
    }
    return null;
  }
  function copyText(s) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(s);
    return new Promise((ok, ko) => {
      const ta = document.createElement("textarea");
      ta.value = s; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy") ? ok() : ko(); } catch (e) { ko(e); } finally { ta.remove(); }
    });
  }
  const touchDevice = () => matchMedia("(pointer: coarse)").matches;
  async function share(ctx) {
    const d = shareData(ctx);
    if (!d) return;
    if (navigator.share && touchDevice()) {
      try { await navigator.share({ title: APP_NAME, text: d.text, url: d.url }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }   // cerrado por el usuario: nada que hacer
    }
    try { await copyText(d.url); toast(t("share_copied")); } catch { toast(t("share_fail")); }
  }
  document.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", () => share(b.dataset.share)));
  // El trayecto solo se puede compartir con origen o destino (que no sea "mi ubicación").
  const updateTripShare = () => ($('[data-share="trip"]').hidden = !shareData("trip"));

  // ---------- Información útil ----------
  // Solo enlaces a páginas oficiales de Vitrasa: no se lee ni se interpreta su contenido.
  const VITRASA = "https://www.vitrasa.es";
  const INFO_LINKS = [
    ["info_grp_main", [
      ["l_alerts", "/avisos"],
      ["l_lines", "/lineas-y-horarios/todas-las-lineas"],
      ["l_fares", "/tarifas-y-titulos"],
      ["l_customer", "/informacion/atencion-al-cliente"],
      ["l_rules", "/informacion/normas-del-servicio"],
    ]],
    ["info_grp_services", [
      ["l_night", "/informacion/servicios/bus-nocturno"],
      ["l_airport", "/informacion/serivicios/aeropuerto"],   // así está en vitrasa.es ("serivicios")
      ["l_hospitals", "/hospitales"],
      ["l_uni", "/informacion/servicios/lanzaderas-universidad"],
      ["l_football", "/informacion/servicios/lanzaderas-futbol"],
      ["l_demand", "/informacion/servicios/paradas-a-demanda"],
      ["l_access", "/informacion/servicios/accesibilidad"],
    ]],
  ];
  const EXT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
  // Sobre esta web: autoría y código fuente (AGPL-3.0: quien use la web tiene que poder conseguir
  // el código; TERMINOS-ADICIONALES.md pide además esta mención visible en las copias).
  const REPO = "https://github.com/proximovitrasa/proximovitrasa.github.io";
  // Más como en el mockup (rediseño): el servicio de Vitrasa en lista, los servicios especiales en
  // etiquetas y el recuadro "Sobre ProximoVitrasa" (mención de autoría que pide la licencia).
  const WARN_SVG = '<svg class="warn-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/></svg>';
  const ARROW_SVG = '<svg class="ext" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>';
  const SHORT = { l_uni: "sp_uni", l_football: "sp_football" };
  function renderInfo() {
    const [[, main], [, extra]] = INFO_LINKS;
    $("#info-list").innerHTML =
      `<li class="sec-head">${esc(t("more_service"))}</li>` +
      main.map(([k, path]) => `<li><a class="info-link" href="${VITRASA}${path}" target="_blank" rel="noopener"><span class="name">${k === "l_alerts" ? WARN_SVG : ""}${esc(t(k))}</span>${ARROW_SVG}</a></li>`).join("") +
      `<li class="sec-head">${esc(t("info_grp_services"))}</li>
       <li class="sp-chips">${extra.map(([k, path]) => `<a href="${VITRASA}${path}" target="_blank" rel="noopener">${esc(t(SHORT[k] || k))}</a>`).join("")}</li>
       <li class="about-box"><b>${esc(t("about_title"))}</b><p>${esc(t("about_short"))}</p>
         <span><a href="${REPO}" target="_blank" rel="noopener">${esc(t("about_code_s"))}</a><a href="${REPO}/blob/main/TERMINOS-ADICIONALES.md" target="_blank" rel="noopener">${esc(t("about_terms_s"))}</a></span></li>`;
    const canInstall = onPhone() && !standalone() && (installEvt || manualSteps());
    $("#more-install").hidden = !canInstall;
    $("#more-about").hidden = !!canInstall;
  }
  function showInfo() {
    leaveStop();
    clearLine();
    showView("info");
    document.title = `${t("info_title")} · ${APP_NAME}`;
    renderInfo();
    if (!isDesktop()) panel.dataset.state = "full";
  }
  $("#info-back").addEventListener("click", goBack);
  $("#place-trip").addEventListener("click", () => { if (place) openTrip({ kind: "addr", ll: place.ll, label: place.label, approx: place.approx }); });

  // ---------- Números de portal en el mapa ----------
  // Con zoom alto se dibujan todos los números de portal conocidos (aunque el mapa base ya traiga
  // algunos). Van en un lienzo propio; solo los que caen en pantalla y sin que se pisen entre ellos.
  // Tocar uno abre esa dirección (o, en "Cómo llegar", la elige como origen o destino).
  // Mismo zoom desde el que el mapa de OpenStreetMap empieza a pintar sus números de portal (17).
  const NUM_ZOOM = 18;     // uno más que el mapa base (17), para no cargar tanto la vista
  const PLACE_ZOOM = 18;   // al abrir una dirección
  map.createPane("nums").style.zIndex = 450;   // encima de los trazados, debajo de las paradas
  map.getPane("nums").style.pointerEvents = "none";
  const numCanvas = L.DomUtil.create("canvas", "num-canvas", map.getPane("nums"));
  let numHits = [];   // { x, y, w, h, pt } en coordenadas del mapa (contenedor)
  const numsOn = () => map.getZoom() >= NUM_ZOOM && !tripRouteOn && !active;

  function drawNums() {
    numHits = [];
    const ctx = numCanvas.getContext("2d");
    const size = map.getSize(), dpr = window.devicePixelRatio || 1;
    if (numCanvas.width !== size.x * dpr || numCanvas.height !== size.y * dpr) {
      numCanvas.width = size.x * dpr; numCanvas.height = size.y * dpr;
      numCanvas.style.width = `${size.x}px`; numCanvas.style.height = `${size.y}px`;
    }
    L.DomUtil.setPosition(numCanvas, map.containerPointToLayerPoint([0, 0]));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    drawVertical(ctx);
    if (!numsOn()) return;
    if (!dirData) { ensureDir().then(drawNums).catch(() => {}); return; }
    const b = map.getBounds().pad(0.05);
    const pts = dirData.portalsIn(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
    const z = map.getZoom();
    // Discretos: letra pequeña, color claro y halo fino (el portal elegido, en rojo).
    ctx.font = `500 ${z >= 19 ? 12 : 11}px Barlow, system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineJoin = "round"; ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,.75)";
    const boxes = [];
    const selKey = place && /\d/.test(place.label) ? place.label : null;
    for (const pt of pts) {
      const p = map.latLngToContainerPoint(pt.ll);
      const w = ctx.measureText(pt.n).width + 4, h = 14;
      const box = { x: p.x - w / 2, y: p.y - h / 2, w, h, pt };
      numHits.push(box);
      if (boxes.some((o) => box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h)) continue;
      boxes.push(box);
      const sel = selKey === `${pt.s.name}, ${pt.n}`;
      ctx.fillStyle = sel ? "#D3202F" : "rgba(91,79,69,.72)";
      ctx.strokeText(pt.n, p.x, p.y);
      ctx.fillText(pt.n, p.x, p.y);
    }
  }
  // ---------- Vigo Vertical en el mapa ----------
  // Rampas, escaleras mecánicas y ascensores (data/vigo-vertical.json), dibujados en el mismo lienzo
  // que los números de portal y con el mismo estilo discreto, desde zoom 16; no se pueden tocar.
  // Rampa: trazo con una flecha hacia arriba; escalera mecánica: además, peldaños; ascensor: un
  // cuadradito con flechas arriba y abajo (el inclinado, sobre su trazo).
  const VV_ZOOM = 16;
  let vvData = null, vvLoading = null;
  function ensureVertical() {
    if (!vvLoading) vvLoading = fetch("data/vigo-vertical.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((d) => { vvData = d; return d; }).catch((e) => { vvLoading = null; throw e; });
    return vvLoading;
  }
  const VV_INK = "rgba(91,79,69,.78)", VV_HALO = "rgba(255,255,255,.85)";
  function liftIcon(ctx, x, y, s) {
    ctx.fillStyle = VV_HALO;
    const box = (x0, y0, w, r) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0, y0, w, w, r); else ctx.rect(x0, y0, w, w); ctx.fill(); };
    box(x - s / 2 - 1.5, y - s / 2 - 1.5, s + 3, 4);
    ctx.fillStyle = VV_INK;
    box(x - s / 2, y - s / 2, s, 3);
    ctx.fillStyle = "#fff";
    const a = s * 0.22;
    ctx.beginPath(); ctx.moveTo(x, y - s * 0.36); ctx.lineTo(x + a, y - s * 0.06); ctx.lineTo(x - a, y - s * 0.06); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x, y + s * 0.36); ctx.lineTo(x + a, y + s * 0.06); ctx.lineTo(x - a, y + s * 0.06); ctx.fill();
  }
  function drawVertical(ctx) {
    if (map.getZoom() < VV_ZOOM || active) return;
    if (!vvData) { ensureVertical().then(drawNums).catch(() => {}); return; }
    const z = map.getZoom(), lw = z >= 18 ? 4 : 3, s = z >= 18 ? 14 : 12;
    const b = map.getBounds().pad(0.1);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const el of vvData.elementos) {
      if (!b.contains(el.ka) && !b.contains(el.kb)) continue;
      const p = map.latLngToContainerPoint(el.ka), q = map.latLngToContainerPoint(el.kb);
      if (el.t === "ascensor") { liftIcon(ctx, p.x, p.y, s); continue; }
      const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
      ctx.strokeStyle = VV_HALO; ctx.lineWidth = lw + 3;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      ctx.strokeStyle = VV_INK; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      if (el.t === "escalera" && L > 14) {   // peldaños
        ctx.lineWidth = 1.5;
        for (let d = 5; d < L - 3; d += 5) {
          const cx = p.x + ux * d, cy = p.y + uy * d;
          ctx.beginPath(); ctx.moveTo(cx - uy * (lw + 2), cy + ux * (lw + 2)); ctx.lineTo(cx + uy * (lw + 2), cy - ux * (lw + 2)); ctx.stroke();
        }
      }
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      if (el.t === "inclinado") { liftIcon(ctx, mx, my, s); continue; }
      if (L < 10) continue;
      // Flecha hacia el extremo de arriba (las rampas y escaleras suben).
      const h = lw + 4;
      ctx.fillStyle = VV_INK; ctx.strokeStyle = VV_HALO; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(mx + ux * h, my + uy * h);
      ctx.lineTo(mx - ux * h * 0.6 - uy * h, my - uy * h * 0.6 + ux * h);
      ctx.lineTo(mx - ux * h * 0.6 + uy * h, my - uy * h * 0.6 - ux * h);
      ctx.closePath(); ctx.stroke(); ctx.fill();
    }
  }

  // Durante el zoom animado el lienzo se esconde; se vuelve a dibujar al terminar.
  map.on("zoomstart", () => { numCanvas.style.visibility = "hidden"; });
  map.on("moveend zoomend resize", () => { numCanvas.style.visibility = ""; drawNums(); });

  // Portal tocado: el número más cercano al toque (a menos de 16 px).
  function numAt(cp) {
    if (!numsOn()) return null;
    let best = null, bd = 16;
    for (const b of numHits) {
      const d = Math.hypot(cp.x - (b.x + b.w / 2), cp.y - (b.y + b.h / 2));
      if (d < bd) { bd = d; best = b.pt; }
    }
    return best;
  }
  // El toque que sigue a una pulsación larga ("Desde aquí / Hasta aquí") no cuenta como toque.
  let heldAt = 0;
  const justHeld = () => Date.now() - heldAt < 700;
  map.on("click", (e) => {
    if (tripOpen() || justHeld() || e.originalEvent._stopHit) return;   // en "Cómo llegar" lo atiende su propio manejador
    const pt = numAt(e.containerPoint);
    if (pt) openPlace({ ll: pt.ll, label: `${pt.s.name}, ${pt.n}`, approx: false }, { replace: panel.dataset.view === "place" });
  });

  // ---------- Cómo llegar (de A a B; por ahora, a pie) ----------
  // Cada extremo es { kind: "stop" | "me" | "map", ll: [lat, lon], id? }. En la dirección: #ir/<A>/<B>,
  // con "p1234" para una parada y "lat,lon" para un punto. La ruta se calcula en el propio
  // dispositivo con la red peatonal de OpenStreetMap (js/peaton.js), sin servicios externos.
  const trip = { a: null, b: null, editing: null, picking: null, sel: null, when: null, whenMode: "dep" };   // sel: opción abierta; when: hora elegida (Date) o null = ahora; whenMode: "dep" salir a esa hora, "arr" llegar a esa hora
  const tripLayer = L.layerGroup().addTo(map);
  // Recorrido que le queda al bus en vivo hasta la parada de subida: en su propio panel, debajo de
  // los tramos del viaje (así no tapa la parada de subida).
  map.createPane("tripTail").style.zIndex = 390;
  const tailRenderer = L.canvas({ padding: 0.3, pane: "tripTail" });
  const tripPins = {};
  let tripSeq = 0;
  let lastTrip = null;
  const tripOpen = () => !$("#trip").hidden;
  const fmtLL = (ll) => `${ll[0].toFixed(5)},${ll[1].toFixed(5)}`;
  const stopEnd = (s) => ({ kind: "stop", id: s.id, ll: s.ll });
  const ICON_ME = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/></svg>';
  const ICON_MAP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/></svg>';
  const ICON_WALK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13" cy="4.2" r="1.8"/><path d="M9.5 21l2.2-5.5 2.6 2.3V21M11.7 15.5l1-5.3-3.2 1.3-1 3M12.7 10.2l2 2.6 2.8 1"/></svg>';

  // Una dirección viaja en la dirección web como "lat,lon~Rúa de Urzáiz, 19".
  function endToken(p) {
    if (!p) return "";
    if (p.kind === "stop") return `p${p.id}`;
    return p.kind === "addr" ? `${fmtLL(p.ll)}~${encodeURIComponent(p.label)}` : fmtLL(p.ll);
  }
  function parseEnd(tok, prev) {
    if (!tok) return null;
    if (prev && decodeURIComponent(endToken(prev)) === tok) return prev;   // conserva "Mi ubicación" al volver
    if (tok[0] === "p" && byId.has(tok.slice(1))) return stopEnd(byId.get(tok.slice(1)));
    const m = tok.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:~(.+))?$/);
    if (!m) return null;
    const ll = [Number(m[1]), Number(m[2])];
    return m[3] ? { kind: "addr", ll, label: m[3] } : { kind: "map", ll };
  }
  function endLabel(p) {
    if (!p) return "";
    if (p.kind === "stop") return `${byId.get(p.id).name} (${p.id})`;
    if (p.kind === "addr") return p.label;
    return p.kind === "me" ? t("my_location") : t("map_point");
  }

  // Diccionario de calles y portales (js/direcciones.js); se descarga al abrir "Cómo llegar".
  let dirData = null;
  const ensureDir = () => window.PV_DIR.load().then((d) => (dirData = d));
  const pinIcon = (w) => L.divIcon({ className: "trip-pin", html: `<span class="pin pin-${w}">${w.toUpperCase()}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });

  function openTrip(b) {
    if (!trip.a && me && !farFromVigo(me)) trip.a = { kind: "me", ll: me };
    if (b) trip.b = b;
    navigate(`ir/${endToken(trip.a)}/${endToken(trip.b)}`);
  }

  // Profundidad del historial al entrar en "Cómo llegar" (para salir de una vez, ver #trip-back).
  let tripEntryDepth = null;
  function showTrip(h) {
    const d = (history.state && history.state.d) || 0;
    if (panel.dataset.view !== "trip" || tripEntryDepth == null || d < tripEntryDepth) tripEntryDepth = d;
    leaveStop();
    clearLine();
    // Cada parte se decodifica por separado: el nombre de una calle puede llevar "/".
    const [, ta = "", tb = ""] = location.hash.slice(1).split("/").map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
    trip.a = parseEnd(ta, trip.a);
    trip.b = parseEnd(tb, trip.b);
    trip.picking = null;
    const same = tripOpen() && lastTrip && lastTrip.hash === location.hash;
    showView("trip");
    $("#trip").classList.remove("when-open");
    document.title = `${t("trip_title")} · ${APP_NAME}`;
    if (!isDesktop() && panel.dataset.state !== "full") panel.dataset.state = baseState();
    closeSugg();
    renderTripFields();
    renderWhen();
    if (same) {
      // Mismo origen y destino: solo cambia la opción abierta (botón Atrás o Adelante).
      trip.sel = (history.state && history.state.opt) || null;
      renderTripResult();
      drawTrip(true);
    } else computeTrip(true);
    ensureDir().catch(() => {});
  }

  function leaveTrip() {
    tripSeq++;
    trip.picking = null;
    trip.sel = null;
    lastTrip = null;
    stopTripLive();
    tripLayer.clearLayers();
    Object.values(tripPins).forEach((m) => m.remove());
    tripRouteOn = false;
    updateStopVisibility();
  }

  // Puntos en el agua (56): un punto tocado en el mar se unía con una línea recta a la calle más
  // cercana (hasta a 600 m) y parecía que se andaba sobre el agua. Con el mapa de fondo vectorial se
  // mira su capa de agua (lo de encima: un muelle o un paseo sobre el agua sí valen); sin él, se
  // rechaza el punto si queda a más de FAR_STREET_M de cualquier calle.
  const FAR_STREET_M = 150;
  function waterAt(ll) {
    if (!glReady || !glLayer) return null;
    try {
      const gl = glLayer.getMaplibreMap();
      const top = gl.queryRenderedFeatures(gl.project([ll[1], ll[0]])).find((f) => f.layer && f.layer.type === "fill");
      return !!top && top.sourceLayer === "water";
    } catch { return null; }
  }
  // true si el punto vale como origen o destino; si no, avisa.
  async function onLand(ll) {
    const w = waterAt(ll);
    if (w) { toast(t("in_water")); return false; }
    if (w === null) {
      try {
        const net = await window.PV_PEATON.load();
        const s = net.snap(ll[0], ll[1]);
        if (!s || s.off > FAR_STREET_M) { toast(t("far_street")); return false; }
      } catch { /* sin red peatonal: se acepta */ }
    }
    return true;
  }
  function setEnd(which, p) {
    if (p && p.kind === "map" && !p.checked) {
      onLand(p.ll).then((ok) => { if (ok) setEnd(which, { ...p, checked: true }); });
      return;
    }
    if (p) delete p.checked;
    trip[which] = p;
    trip.picking = null;
    $("#toast").hidden = true;   // el aviso de "toca el mapa" ya no hace falta
    tripReplace();
    $(`#trip-${which}`).blur();
    closeSugg();
    renderTripFields();
    setPanel(baseState());
    computeTrip(true);
  }

  // Dirección web al día con los extremos (sin opción abierta: hay que volver a calcular).
  function tripReplace() {
    trip.sel = null;
    const h = `#ir/${endToken(trip.a)}/${endToken(trip.b)}`.replace(/\/+$/, "");
    history.replaceState({ d: (history.state && history.state.d) || 0 }, "", h);
  }

  // A qué campo va un punto elegido en el mapa: el que se está editando o el primero vacío.
  const targetEnd = () => trip.picking || trip.editing || (!trip.a ? "a" : "b");
  function tripPickStop(s) { setEnd(targetEnd(), stopEnd(s)); }

  // Cómo llegar: "trip" (rojo, a pantalla completa: elegir y opciones) o "tripd" (pasos de una
  // opción, con el mapa arriba). "ready": ya hay origen y destino.
  function syncTripScreen() {
    if (panel.dataset.view !== "trip") return;
    $("#trip").classList.toggle("ready", !!(trip.a && trip.b));
    const scr = trip.sel && lastTrip ? "tripd" : "trip";
    // Al abrir los pasos en el móvil, la hoja baja para dejar ver el mapa con el recorrido.
    if (scr === "tripd" && panel.dataset.screen !== "tripd" && !isDesktop()) panel.dataset.state = "stop";
    panel.dataset.screen = scr;
    const on = !!(trip.sel && tripFavFor(trip.sel));
    $("#tf-star").setAttribute("aria-pressed", on);
    $("#tf-star").setAttribute("aria-label", t(on ? "trip_unfav" : "trip_fav"));
    $("#tf-star").title = t(on ? "trip_unfav" : "trip_fav");
  }
  function renderTripFields() {
    updateTripShare();
    syncTripScreen();
    ["a", "b"].forEach((w) => {
      const inp = $(`#trip-${w}`);
      if (document.activeElement !== inp) inp.value = endLabel(trip[w]);
      $(`[data-clear="${w}"]`).hidden = !inp.value;
      inp.closest(".trip-field").classList.toggle("picking", trip.picking === w);
      const p = trip[w];
      if (p && tripOpen()) {
        if (!tripPins[w]) {
          tripPins[w] = L.marker(p.ll, { icon: pinIcon(w), draggable: true, keyboard: false, zIndexOffset: 1000 })
            .on("dragend", (e) => { const ll = e.target.getLatLng(); setEnd(w, { kind: "map", ll: [ll.lat, ll.lng] }); });
        }
        tripPins[w].setLatLng(p.ll).addTo(map);
      } else if (tripPins[w]) tripPins[w].remove();
    });
  }

  // Mi ubicación y Elegir en el mapa, con su icono y una línea que explica qué hacen (mockup 12).
  const TILE_ME = '<svg class="ln me" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/></svg>';
  const TILE_MAP = '<svg class="ln" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg>';
  const TILE_CLOCK = '<svg class="ln" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  function specialItem(kind, icon, label) {
    return resRow(`data-trip="${kind}"`, kind === "me" ? TILE_ME : TILE_MAP, esc(label), esc(t(kind === "me" ? "my_location_sub" : "pick_map_sub")));
  }
  // Recientes en Desde / Hasta: con un reloj y lo que son (parada, sitio o dirección).
  function tripRecentRows() {
    const rows = [];
    recents.forEach((r, k) => {
      if (r.id) { const s = byId.get(r.id); if (s) rows.push(resRow(`data-id="${esc(s.id)}"`, TILE_CLOCK, esc(s.name), esc(t("stop_n", { id: s.id })))); return; }
      rows.push(resRow(`data-recent="${k}"`, TILE_CLOCK, esc(r.label), esc(r.site ? t(`site_${r.site}`) : t("fav_address"))));
    });
    return rows.length ? [secHead(t("recents")), ...rows] : [];
  }

  // Una calle propuesta. num: número escrito; "" toda la calle; null falta el número (al tocarla
  // se completa el campo con "Calle, " para seguir escribiendo).
  function addrItem(st, num, tokens, tile = false) {
    const li = document.createElement("li");
    let sub;
    if (num === null) sub = t("addr_add_num");
    else if (num === "") sub = t("addr_whole");
    else sub = dirData.resolve(st, num).exact ? t("addr_exact") : t("addr_approx");
    // Calles con el mismo nombre en sitios distintos: se dice cerca de qué parada están.
    if (st.dup && stops.length) sub += ` · ${t("near_stop", { name: nearest(st.ll, 1)[0].s.name })}`;
    const label = num ? `${st.name}, ${num}` : st.name;
    if (tile) {
      return resRow(`data-addr="${st.i}" data-num="${num === null ? "" : esc(num)}"${num === null ? ' data-fill="1"' : ""}`, PIN_TILE,
        highlight(num === null ? `${st.name}, …` : label, tokens), esc(sub), me ? haversine(me, dirData.resolve(st, num || "").ll) : null);
    }
    li.innerHTML = `<button type="button" data-addr="${st.i}" data-num="${num === null ? "" : esc(num)}"${num === null ? ' data-fill="1"' : ""}>
      <span class="name">${highlight(label, tokens)}</span>
      <span class="sub">${esc(sub)}</span>
      ${me ? `<span class="dist">${fmtDist(haversine(me, dirData.resolve(st, num || "").ll))}</span>` : ""}
    </button>`;
    return li;
  }

  // Sugerencias mientras se escribe en Desde o Hasta: direcciones (calle y número) y paradas.
  function openSugg(which) {
    trip.editing = which;
    const inp = $(`#trip-${which}`);
    const q = inp.value.trim();
    const typed = q && q !== endLabel(trip[which]) ? q : "";
    $(`[data-clear="${which}"]`).hidden = !inp.value;
    const special = [specialItem("me", ICON_ME, t("my_location")), specialItem("map", ICON_MAP, t("pick_map"))];
    const items = [];
    if (typed && !dirData) ensureDir().then(() => { if (trip.editing === which) openSugg(which); }).catch(() => {});
    if (typed) {
      // Como en el mockup (12): "Resultados" (paradas, sitios y direcciones), luego Mi ubicación y
      // Elegir en el mapa, y las buscadas recientemente.
      const tokens = norm(typed).split(" ").filter(Boolean);
      const addr = [];
      if (dirData) {
        const p = dirData.parse(typed);
        const found = dirData.matchStreets(p.street, p.num ? 4 : 6);
        found.forEach((st) => addr.push(addrItem(st, p.num, tokens, true)));
        // Con número a medio escribir: otros portales conocidos de la primera calle ("1" → 10, 12…).
        if (p.num && found[0]) dirData.numbersStarting(found[0], p.num).forEach((n) => addr.push(addrItem(found[0], n, tokens, true)));
      }
      if (!sitesData && /\p{L}.*\p{L}.*\p{L}/u.test(typed)) ensureSites().then(() => { if (trip.editing === which) openSugg(which); }).catch(() => {});
      const sites = /\p{L}.*\p{L}.*\p{L}/u.test(typed) ? matchSites(typed) : [];
      const res = matchStops(typed).slice(0, addr.length || sites.length ? 5 : 40);
      items.push(secHead(t("results")));
      res.forEach((s) => items.push(resStop(s, highlight(s.name, tokens))));
      sites.forEach((x) => items.push(siteItem(x, tokens)));
      items.push(...addr);
      if (!addr.length && !res.length && !sites.length) {
        const li = document.createElement("li");
        li.className = "note-li";
        li.textContent = t("trip_no_stops", { q: typed });
        items.push(li);
      }
    }
    special[0].classList.add("gap");
    $("#trip-sugg").replaceChildren(...items, ...special, ...tripRecentRows());
    $("#trip-sugg").hidden = false;
    $("#trip-result").hidden = true;
    $("#trip").classList.add("editing");   // mientras se escribe, sin las filas de hora y preferencias
    $("#trip-sugg").scrollTop = 0;
  }
  function closeSugg() {
    trip.editing = null;
    $("#trip-sugg").hidden = true;
    $("#trip-result").hidden = false;
    $("#trip").classList.remove("editing");
  }

  // ---------- Planificador: en bus de A a B ----------
  // Las opciones salen de los horarios (js/planificador.js, data/viajes.json) y después se corrigen
  // con los tiempos en vivo de las paradas de subida. Cada 30 s se vuelve a calcular todo.
  const PLAN = window.PV_PLAN;
  const MAX_WALK_STOP = 1000;        // metros a pie como máximo hasta la parada de subida o desde la de bajada
  const ORIGIN_LIVE = 6;                // paradas más cercanas a A que se piden en vivo (horario en vivo)
  const FULL_EVERY = 4;                 // cada 4 vueltas (2 min) se piden todas las paradas de los candidatos
  const LIVE_MAX_AGE = 180000;          // un dato en vivo de más de 3 min no se usa en Cómo llegar
  const liveCache = new Map();       // parada → { at, list | null } (null: sin respuesta)
  const walkCache = new Map();       // tramos a pie ya calculados
  let tripTimer = null, tripTick = null, tripBuses = [];

  function stopTripLive() {
    clearTimeout(tripTimer);
    clearInterval(tripTick);
    tripTimer = tripTick = null;
    tripBuses.forEach((b) => { if (b.marker) b.marker.remove(); if (b.tail) b.tail.forEach((x) => x.remove()); });
    tripBuses = [];
  }

  const WIDE_WALK_STOP = 2500;       // si así no hay ningún bus, se buscan paradas más lejos
  // Paradas alcanzables a pie desde un punto: Map(índice de parada en el plan → metros equivalentes,
  // es decir, el tiempo a pie con las cuestas; ver js/peaton.js). toward: andando desde la parada
  // hasta el punto (las de bajada), para que las cuestas cuenten en el sentido en que se anda.
  // out.mech: de esos metros, los que van en rampa, escalera mecánica o ascensor (no cuentan como andar).
  function stopsAround(net, plan, ll, radii = [MAX_WALK_STOP, MAX_WALK_STOP * 1.6], toward = false) {
    for (const max of radii) {
      const dist = net.around(ll, max, toward);
      const out = new Map();
      out.mech = new Map();
      for (const s of stops) {
        const i = plan.index.get(s.id);
        if (i == null || haversine(ll, s.ll) > max) continue;
        const [m, , mm] = dist(s.ll, null, true);
        if (m <= max) { out.set(i, m); if (mm) out.mech.set(i, mm); }
      }
      if (out.size) return out;
    }
    const none = new Map();
    none.mech = new Map();
    return none;
  }
  // Vigo Vertical: qué rampas, escaleras mecánicas y ascensores funcionan a la hora del viaje.
  function setVerticalTime(net, when) {
    if (net.vertical && net.vertical.length) net.setVertical((el) => PLAN.openAt(net.horarios, el, when));
  }

  // Tiempos en vivo de una parada (se reutilizan durante 20 s).
  function getLive(id) {
    const c = liveCache.get(id);
    if (c && Date.now() - c.at < 20000) return Promise.resolve(c);
    if (lastArrivals && lastArrivalsId === id && lastUpdate && Date.now() - lastUpdate.getTime() < 20000) {
      const e = { at: lastUpdate.getTime(), list: lastArrivals };
      liveCache.set(id, e);
      return Promise.resolve(e);
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    return fetchEstimates(id, ctl.signal)
      .then((d) => ({ at: Date.now(), list: d.estimaciones || [] }))
      .catch(() => ({ at: Date.now(), list: null }))
      .then((e) => { clearTimeout(timer); liveCache.set(id, e); return e; });
  }

  // Buses en vivo de la línea y sentido de un tramo, en su parada de subida, que de verdad llevan a la
  // parada de bajada (ver PV_PLAN.liveReaches). Si la API da buses de la línea pero ninguno sirve, se
  // devuelve null (se usa el horario, sin marcarlo dudoso).
  function liveFor(plan, leg) {
    const e = liveCache.get(plan.ids[leg.board]);
    if (!e || !e.list || Date.now() - e.at > LIVE_MAX_AGE) return null;   // dato viejo: el horario
    const l = lines[leg.line];
    const d = l && l.sentidos[leg.dir];
    const id = plan.ids[leg.board];
    const both = l && l.sentidos.filter((d) => d.paradas.includes(id) || (d.otras || []).includes(id)).length > 1;
    const mine = e.list.filter((x) => normLine(x.linea) === leg.line && (!both || !d || goesTo(d, x.ruta)));
    // Solo los buses que seguro llegan (o de letrero desconocido): ni los de otro ramal o que acaban
    // antes, ni aquellos en los que a esa hora hay viajes con su letrero que llegan y otros que no.
    const good = mine.filter((x) => {
      const r = plan.liveReaches(leg, x.ruta, new Date(e.at + Number(x.minutos) * 60000));
      return r === "yes";   // "unknown" (sin viajes de la línea a esa hora): sin certeza, se usa el horario
    });
    if (mine.length && !good.length) return null;
    return good.map((x) => ({ ...x, _at: e.at }));
  }

  async function computeTrip(fit) {
    const seq = ++tripSeq;
    stopTripLive();
    tripLayer.clearLayers();
    lastTrip = null;
    tripRouteOn = false;
    updateStopVisibility();
    const box = $("#trip-result");
    const ends = [trip.a, trip.b].filter(Boolean).map((p) => p.ll);
    if (ends.length < 2) {
      box.innerHTML = `<p class="trip-note">${esc(t("trip_hint"))}</p>`;
      if (fit && ends.length) focusOn(ends[0], Math.max(map.getZoom(), 15));
      // Se adelanta la descarga de la red y de los horarios para que la ruta salga al instante.
      window.PV_PEATON.load().catch(() => {});
      PLAN.load().catch(() => {});
      return;
    }
    box.innerHTML = `<p class="trip-note">${esc(t("trip_loading"))}</p>`;
    let net, plan = null;
    try { net = await window.PV_PEATON.load(); }
    catch { if (seq === tripSeq) box.innerHTML = `<div class="state"><strong>${esc(t("trip_net_error"))}</strong></div>`; return; }
    try { [plan] = await Promise.all([PLAN.load(), linesReady]); } catch { plan = null; }
    if (seq !== tripSeq) return;
    const vvWhen = arriveMode() ? new Date(trip.when.getTime() - 15 * 60000) : tripStart();
    setVerticalTime(net, vvWhen);
    walkCache.clear();
    const r = net.route(trip.a.ll, trip.b.ll);
    lastTrip = {
      hash: location.hash, net, plan, planError: !plan, fecha: net.fecha, vvWhen,
      walk: r ? { dist: r.dist + r.offFrom + r.offTo, eq: r.eq + r.offFrom + r.offTo, r } : null,
      approx: [trip.a, trip.b].filter((p) => p.kind === "addr" && p.approx).map((p) => p.label),
      cands: [], opts: [], live: false,
    };
    if (plan) {
      lastTrip.origins = stopsAround(net, plan, trip.a.ll);
      lastTrip.dests = stopsAround(net, plan, trip.b.ll, undefined, true);
      planSearch();
      // Siempre debe salir al menos una opción en bus: si no hay ninguna, paradas más lejos.
      if (!lastTrip.cands.length) {
        lastTrip.origins = stopsAround(net, plan, trip.a.ll, [WIDE_WALK_STOP]);
        lastTrip.dests = stopsAround(net, plan, trip.b.ll, [WIDE_WALK_STOP], true);
        planSearch();
      }
    }
    const st = history.state && history.state.opt;
    trip.sel = st && (st === "walk" || lastTrip.opts.some((o) => o.key === st)) ? st : null;
    renderTripResult();
    drawTrip(fit);
    if (lastTrip.cands.length) refreshLive(seq);
  }

  // Preferencia de ruta (11), recordada en este dispositivo.
  const PREF_KEY = "pv:preferencia";
  let tripPref = "fast";
  try { tripPref = ["fast", "transfers", "walk"].includes(localStorage.getItem(PREF_KEY)) ? localStorage.getItem(PREF_KEY) : "fast"; } catch { /* sin almacenamiento */ }
  function renderPref() {
    document.querySelectorAll("#trip-pref [data-pref]").forEach((b) => b.setAttribute("aria-checked", b.dataset.pref === tripPref));
    $("#trip-pref-chip-text").textContent = t(`pref_${tripPref}`);
  }
  $("#trip-pref").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pref]");
    if (!b) return;
    // Con una opción abierta, los botones vuelven a la lista (52): antes la opción abierta se
    // quedaba en el historial y la búsqueda nueva la volvía a abrir, y parecía que no hacían nada.
    const open = !!(history.state && history.state.opt);
    if (b.dataset.pref === tripPref) {
      if (open && lastTrip) { tripReplace(); renderTripResult(); drawTrip(true); }
      return;
    }
    tripPref = b.dataset.pref;
    try { localStorage.setItem(PREF_KEY, tripPref); } catch { /* sin almacenamiento */ }
    renderPref();
    tripReplace();
    computeTrip(false);
  });
  renderPref();

  // Hora de salida: la elegida o, si no hay (o ya pasó), ahora.
  const tripStart = () => (trip.when && trip.whenMode !== "arr" && trip.when > new Date() ? trip.when : new Date());

  // Busca de nuevo (las opciones del horario, aún sin tiempos en vivo).
  function planSearch() {
    const lt = lastTrip;
    const walk = lt.walk ? lt.walk.eq : Infinity;
    const q = { origins: lt.origins, dests: lt.dests, walk, maxTransfers: 2, prefer: tripPref, originsMech: lt.origins.mech, destsMech: lt.dests.mech };
    // "Llegar a las" (10): se busca desde 3 h antes (o desde ahora); si no hay forma de llegar a
    // tiempo, lo antes posible.
    const arriveBy = arriveMode() ? trip.when : null;
    lt.arriveBy = null;
    lt.arriveLate = false;
    if (arriveBy) {
      const now = new Date();
      const start = new Date(Math.max(now.getTime(), arriveBy.getTime() - 3 * 3600000));
      const cands = lt.plan.search({ ...q, time: now, arriveBy });
      if (cands.length) {
        lt.arriveBy = arriveBy;
        setStart(lt, start);
        lt.cands = cands;
      } else lt.arriveLate = true;
    }
    if (!lt.arriveBy) {
      const start = arriveBy ? new Date() : tripStart();
      setStart(lt, start);
      lt.cands = lt.plan.search({ ...q, time: start });
    }
    if (!lt.live) lt.opts = lt.plan.choose(lt.cands, lt.start, walk);
  }
  function setStart(lt, start) {
    lt.start = start;
    lt.base = dayBase(start).getTime();
  }
  const arriveMode = () => !!(trip.when && trip.whenMode === "arr");

  async function refreshLive(seq) {
    const lt = lastTrip;
    if (!lt || !lt.plan) return;
    clearTimeout(tripTimer);
    // Paradas de subida que se piden en vivo (31, fase 3): la primera vez y cada FULL_EVERY vueltas,
    // las de todos los candidatos (una opción oculta puede pasar delante si su bus va mejor); en las
    // demás, solo las de las opciones que se ven y la abierta. Así, cada 30 s, unas pocas paradas en
    // vez de las de hasta 8 candidatos con 3 buses.
    lt.liveRound = (lt.liveRound || 0) + 1;
    const full = lt.liveRound === 1 || lt.liveRound % FULL_EVERY === 1;
    const keys = new Set([...(lt.opts || []).map((j) => j.key), trip.sel]);
    const boards = () => {
      const ids = new Set();
      lt.cands.forEach((j) => { if (full || keys.has(j.key)) j.legs.forEach((l) => l.type === "bus" && ids.add(lt.plan.ids[l.board])); });
      return ids;
    };
    // Horario en vivo: también las paradas más cercanas a A (un bus retrasado que ya "tendría que
    // haber pasado" no está entre los candidatos del horario y solo así se ve).
    const ids = boards();
    if (!lt.arriveBy) {
      [...lt.origins].sort((a, b) => a[1] - b[1]).slice(0, ORIGIN_LIVE).forEach(([i]) => ids.add(lt.plan.ids[i]));
    }
    await Promise.all([...ids].map(getLive));
    if (seq !== tripSeq || lastTrip !== lt) return;
    // Con los retrasos vistos, se vuelve a buscar sobre el horario en vivo y se piden las paradas de
    // subida nuevas (las ya pedidas salen de la caché).
    planSearch();
    const more = [...boards()].filter((id) => !ids.has(id));
    if (more.length) await Promise.all(more.map(getLive));
    if (seq !== tripSeq || lastTrip !== lt) return;
    const now = new Date();
    const re = lt.cands.map((j) => lt.plan.retime(j, (leg) => liveFor(lt.plan, leg), now, lt.start));
    lt.opts = lt.plan.choose(re, lt.start, lt.walk ? lt.walk.eq : Infinity);
    lt.live = true;
    lt.updated = now;
    // La opción abierta se mantiene aunque deje de estar entre las mejores.
    if (trip.sel && trip.sel !== "walk" && !lt.opts.some((o) => o.key === trip.sel)) {
      const keep = re.find((o) => o.key === trip.sel && !o.broken);
      if (keep) lt.opts.push(keep); else trip.sel = null;
    }
    renderTripResult();
    drawTrip(false);
    tripTimer = setTimeout(() => {
      if (seq !== tripSeq || lastTrip !== lt) return;
      if (document.hidden) return;             // al volver a la pestaña se actualiza (visibilitychange)
      refreshLive(seq);                        // vuelve a buscar con los datos en vivo nuevos
    }, REFRESH_MS);
  }

  // ---------- Opciones: textos ----------
  const nowSec = () => (Date.now() - lastTrip.base) / 1000;
  const startSec = () => Math.max(nowSec(), (lastTrip.start - lastTrip.base) / 1000);
  const clock = (sec) => new Date(lastTrip.base + sec * 1000).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  function durHtml(min) {
    return etaNum(Math.max(1, Math.round(min)));
  }
  const stopName = (i) => { const s = byId.get(lastTrip.plan.ids[i]); return s ? s.name : lastTrip.plan.ids[i]; };
  const badge = (code) => `<span class="badge"${lineStyle(code)}>${esc(code)}</span>`;
  const walkChip = (m) => { const n = walkMin(m); return `<span class="walk-chip">${ICON_WALK}<small>${n < 60 ? n : `${Math.floor(n / 60)}h${n % 60 ? String(n % 60).padStart(2, "0") : ""}`}</small></span>`; };
  const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  // "Pasa en 4 min" (en vivo) / "A las 9:14" (horario).
  function whenHtml(leg) {
    const m = Math.round((leg.dep - nowSec()) / 60);
    const txt = m <= 0 ? t("arriving") : m < 60 ? t("in_min", { n: m }) : atTime(leg.dep);
    if (leg.live) return `<span class="live">${esc(txt)}</span>`;
    return `<span class="sched">${esc(m < 60 && m > 0 ? atTime(leg.dep) : txt)} · ${esc(t("scheduled"))}</span>`;
  }
  // Hora de una salida o llegada, con "mañana" si es del día siguiente.
  // Duración de una opción: desde que sales de A (andando hasta la primera parada incluido) hasta
  // que llegas a B; sin la espera hasta que toca salir (p. ej. de noche, al primer bus de la mañana).
  // Si hay que esperar más de 3 min antes de salir, se dice a qué hora (la duración no cuenta esa
  // espera; sin el aviso, un bus de "17 min" parecía más rápido que andar 19 aunque llegase después).
  const LEAVE_NOTE_MIN = 3;
  const leaveSec = (j) => Math.max(j.dep, nowSec());
  const tripMin = (j) => (j.arr - leaveSec(j)) / 60;
  function leaveText(j, always) {
    const s = leaveSec(j);
    if (!always && s - startSec() <= LEAVE_NOTE_MIN * 60) return "";
    return t(nextDay(s) ? "leave_time_tomorrow" : "leave_time", { time: clock(s) });
  }
  const nextDay = (sec) => sec >= 86400 && new Date(lastTrip.base + sec * 1000).getDate() !== new Date().getDate();
  const atTime = (sec) => t(nextDay(sec) ? "tomorrow_at" : "at_time", { time: clock(sec) });
  const arriveAt = (sec) => t(nextDay(sec) ? "arrive_tomorrow" : "arrive_at", { time: clock(sec) });
  const arriveShort = (sec) => (nextDay(sec) ? arriveAt(sec) : t("arrive_short", { time: clock(sec) }));
  // Cuándo pasa el bus (mockups 1 y 2): en vivo, en verde con un punto; según horario, en naranja con un reloj.
  const CLOCK_SVG = '<svg class="ck" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  function statusHtml(leg) {
    const m = Math.round((leg.dep - nowSec()) / 60);
    if (leg.live) return `<span class="live">${esc(m <= 0 ? t("arriving") : m < 60 ? t("in_min", { n: m }) : atTime(leg.dep))}</span><span class="live-tag"> · ${esc(t("live_tag"))}</span>`;
    return `<span class="sched">${CLOCK_SVG}${esc(m <= 0 ? t("arriving") : m < 60 ? t("sched_in", { n: m }) : nextDay(leg.dep) ? atTime(leg.dep) : t("sched_at", { time: clock(leg.dep) }))}</span>`;
  }
  const SHORT_TRANSFER_MIN = 3;
  function chain(j) {
    const parts = [];
    j.legs.forEach((l, k) => {
      if (l.type === "bus") parts.push(badge(l.line));
      // En la lista, los cambios a pie cortos (< 3 min, sin rampas ni ascensores) no se pintan: la fila
      // de 2–3 buses cabe en un renglón en el móvil. En los pasos de la opción siguen con su espera.
      else if (l.transfer && walkMin(l.m) < SHORT_TRANSFER_MIN && !walkVV(j, k).length) return;
      else if (l.m >= 60) parts.push(walkChip(l.m) + (walkVV(j, k).length ? `<span class="vv-chip">${ICON_VV}</span>` : ""));
    });
    return parts.join(CHEV);
  }

  // Transbordos justos: minutos que quedan entre llegar (andando) a la parada del siguiente bus y
  // que este salga. Se sigue proponiendo la opción, pero con aviso si son menos de 5.
  const TIGHT_MIN = 5;
  function transferSlack(j, k) {   // k: posición del tramo a pie del transbordo en j.legs
    const prev = j.legs[k - 1], next = j.legs[k + 1];
    return (next.dep - prev.arr - j.legs[k].m / lastTrip.plan.WALK) / 60;
  }
  const isTight = (j) => j.legs.some((l, k) => l.transfer && transferSlack(j, k) < TIGHT_MIN);

  // Opción que se ve en el mapa: la elegida o, si no, la primera de la lista.
  // Trayectos favoritos (37): la estrella de cada opción la guarda o la quita.
  const favEnd = (p) => (p && p.kind !== "me" ? endToken(p) : "");
  const favEndLabel = (p) => (p && p.kind !== "me" ? (p.kind === "map" ? placeName(p.ll) : endLabel(p)) : null);
  const tripFavFor = (key) => favs.trips.find((f) => f.a === favEnd(trip.a) && f.b === favEnd(trip.b) && f.key === key);
  function starBtn(key) {
    const on = !!tripFavFor(key);
    const label = t(on ? "trip_unfav" : "trip_fav");
    return `<button type="button" class="icon-btn fav opt-star" data-star="${esc(key)}" aria-pressed="${on}" aria-label="${esc(label)}" title="${esc(label)}">${STAR_SVG}</button>`;
  }
  function toggleTripFav(key) {
    const f = tripFavFor(key);
    if (f) { favs.trips = favs.trips.filter((x) => x !== f); toast(t("trip_unfaved")); }
    else {
      const j = key === "walk" ? null : lastTrip.opts.find((o) => o.key === key);
      favs.trips.push({ a: favEnd(trip.a), b: favEnd(trip.b), al: favEndLabel(trip.a), bl: favEndLabel(trip.b), key,
        lines: j ? j.legs.filter((l) => l.type === "bus").map((l) => l.line) : [] });
      toast(t("trip_faved"));
    }
    saveFavs();
    renderTripResult();
  }
  // Al abrir un trayecto guardado, su opción se destaca si sale (mismos extremos y líneas).
  const wanted = () => trip.want && trip.want.a === favEnd(trip.a) && trip.want.b === favEnd(trip.b) ? trip.want.key : null;
  function shownKey() {
    const lt = lastTrip;
    if (trip.sel) return trip.sel;
    const w = wanted();
    if (w && (w === "walk" ? lt.walk : lt.opts.some((o) => o.key === w))) return w;
    return walkOnTop() || !lt.opts[0] ? "walk" : lt.opts[0].key;
  }
  // ¿Va primero ir andando? Si llega antes que el primer bus (o, con "llegar a las", deja salir más
  // tarde), salvo con la preferencia "Menos a pie": entonces siempre al final, detrás de los buses.
  function walkOnTop() {
    const lt = lastTrip;
    if (!lt.walk) return false;
    const first = lt.opts[0];
    if (!first) return true;
    if (tripPref === "walk") return false;
    return lt.arriveBy
      ? (lt.arriveBy - lt.base) / 1000 - walkMin(lt.walk.eq) * 60 >= first.dep
      : startSec() + walkMin(lt.walk.eq) * 60 <= first.arr;
  }
  const busKey = (l) => `${l.line}|${l.board}`;

  // Lista de opciones; con una elegida, sus pasos.
  function renderTripResult() {
    const lt = lastTrip;
    if (!lt) return;
    const box = $("#trip-result");
    const walkMinTotal = lt.walk ? walkMin(lt.walk.eq) : Infinity;
    const notes = (lt.approx || []).map((label) => `<p class="trip-note">${esc(t("approx_note", { label }))}</p>`).join("");
    if (trip.sel) {
      const j = trip.sel === "walk" ? null : lt.opts.find((o) => o.key === trip.sel);
      if (trip.sel === "walk" || j) { box.innerHTML = renderSteps(j) + notes; syncTripScreen(); return; }
      trip.sel = null;
    }
    syncTripScreen();
    const shown = shownKey();
    const cur = (k) => (k === shown ? ' aria-current="true"' : "");
    const arr = !!lt.arriveBy;
    const items = lt.opts.map((j) => {
      const first = j.legs.find((l) => l.type === "bus");
      const total = tripMin(j);
      const lt0 = leaveText(j, arr);
      const leave = lt0 ? `${esc(lt0)} · ` : "";
      const late = j.late ? ` <span class="warn">${esc(t("arrive_late_live"))}</span>` : "";
      return `<li class="opt-li"><button type="button" class="opt" data-opt="${esc(j.key)}"${cur(j.key)}>
        <span class="chain">${chain(j)}</span>
        <span class="eta">${durHtml(total)}</span>
        <span class="when">${leave}${statusHtml(first)}${late}${first.doubtful ? `<span class="warn nl"> · ${esc(t("no_live"))}</span>` : ""}${isTight(j) ? ` <span class="warn">${esc(t("tight_transfer"))}</span>` : ""}</span>
        <span class="arr">${esc(arriveShort(j.arr))}</span>
      </button>${starBtn(j.key)}</li>`;
    });
    // Ir andando: primero si llega antes que cualquier bus; si no, al final.
    if (lt.walk) {
      const T = arr ? (lt.arriveBy - lt.base) / 1000 : null;
      const walkDep = arr ? T - walkMinTotal * 60 : startSec();
      const w = `<li class="opt-li"><button type="button" class="opt walk" data-opt="walk"${cur("walk")}>
        <span class="chain">${ICON_WALK}<span class="what">${esc(t("on_foot"))}</span></span>
        <span class="eta">${durHtml(walkMinTotal)}</span>
        <span class="when">${arr ? `${esc(t("leave_time", { time: clock(Math.max(walkDep, nowSec())) }))} · ` : ""}${esc(fmtDist(lt.walk.dist))}</span>
        <span class="arr">${esc(arriveShort(walkDep + walkMinTotal * 60))}</span>
      </button>${starBtn("walk")}</li>`;
      if (walkOnTop()) items.unshift(w); else items.push(w);
    }
    let head = "";
    if (lt.planError) head = `<p class="trip-note">${esc(t("plan_error"))}</p>`;
    else if (!lt.opts.length) head = `<div class="state"><strong>${esc(t("plan_none"))}</strong></div>`;
    if (lt.arriveLate && trip.when) head = `<p class="trip-note warn">${esc(t("arrive_impossible", { time: trip.when.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) }))}</p>` + head;
    if (!items.length) head = `<div class="state"><strong>${esc(t("trip_none"))}</strong></div>`;
    const date = lt.plan ? new Date(`${lt.plan.fecha}T12:00:00`).toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" }) : "";
    // Origen de los tiempos, encima de las opciones.
    const src = lt.opts.length ? `<p class="trip-note src" title="${esc(t("plan_note", { date }))}">${lt.live ? "" : `${esc(t("live_checking"))} `}${esc(t("src_note"))}</p>` : "";
    box.innerHTML = `${head}${src}<ul class="trip-opts">${items.join("")}</ul>${notes}`;
  }

  // Pasos de una opción como en el mockup (2): resumen arriba y una línea de tiempo con la hora de
  // cada punto (salida, subida, bajada y llegada); los tramos en bus, con las paradas desplegables.
  const ptRow = (cls, name, sec) => `<li class="step pt ${cls}"><span class="ico"><i></i></span><span class="txt"><b>${esc(name)}</b></span>${sec != null ? `<span class="tm">${esc(clock(sec))}</span>` : ""}</li>`;
  function renderSteps(j) {
    const lt = lastTrip;
    const back = `<button type="button" class="opts-back" data-opt-back="1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>${esc(t("all_options"))}</button>`;
    const acts = `<span class="desk-acts"><button type="button" class="icon-btn" data-tfshare="1" aria-label="${esc(t("share"))}" title="${esc(t("share"))}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg></button>${starBtn(trip.sel)}</span>`;
    if (!j) {
      // A pie: como antes de existir el planificador.
      const date = new Date(`${lt.fecha}T12:00:00`).toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" });
      const osm = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${fmtLL(trip.a.ll)}%3B${fmtLL(trip.b.ll)}`;
      const r = lt.walk.r, segs = (r.segs || []).map((x) => ({ ...x }));
      if (segs.length) { segs[0].real += r.offFrom; segs[0].eq += r.offFrom; const z = segs[segs.length - 1]; z.real += r.offTo; z.eq += r.offTo; }
      const wm = walkMin(lt.walk.eq);
      const T = lt.arriveBy ? (lt.arriveBy - lt.base) / 1000 : null;
      const dep = T != null ? Math.max(T - wm * 60, nowSec()) : startSec();
      const vvSt = segs.some((x) => x.used) ? walkPieceSteps(segs, (d) => t("step_walk_dest", { dist: fmtDist(d) }))
        : `<li class="step walk"><span class="ico">${ICON_WALK}</span><span class="txt">${esc(t("walk_short", { dist: fmtDist(lt.walk.dist) }))}<small>${esc(hMin(wm))}</small></span></li>`;
      const shut = shutItem(walkRoute(trip.a.ll, trip.b.ll).shut);
      return `${back}<div class="opt-head"><span class="chain">${ICON_WALK}<span class="what">${esc(t("on_foot"))}</span></span><span class="opt-time"><span class="eta">${durHtml(wm)}</span></span>${acts}</div>
        <ol class="steps">${ptRow("a", endLabel(trip.a), dep)}${vvSt}${shut}${ptRow("b", endLabel(trip.b), dep + wm * 60)}</ol>
        <p class="trip-note">${esc(t("trip_source", { date }))} <a href="${osm}" target="_blank" rel="noopener">${esc(t("trip_compare"))}</a></p>`;
    }
    const steps = [ptRow("a", endLabel(trip.a), leaveSec(j))];
    const legs = j.legs;
    legs.forEach((l, k) => {
      if (l.type === "walk") {
        const next = legs[k + 1];
        const real = walkReal(j, k);
        const textFor = (d) => (k === 0 ? t("walk_short", { dist: fmtDist(d) })
          : l.transfer ? (d < 30 && real < 30 ? t("step_change_same") : t("step_change", { dist: fmtDist(d), place: stopName(next.board) }))
          : t("step_walk_dest", { dist: fmtDist(d) }));
        const text = textFor(real);
        if (real < 30 && !l.transfer) return;
        // Transbordo: siempre la espera prevista en la parada hasta que pase el siguiente bus
        // (con aviso si es menos de 5 min).
        let tight = "";
        if (l.transfer) {
          const n = Math.max(0, Math.floor(transferSlack(j, k)));
          tight = n < TIGHT_MIN ? `<small class="warn">${esc(n < 1 ? t("tight_step_0") : t("tight_step", { n }))}</small>`
            : `<small class="wait">${esc(t("wait_step", { dur: hMin(n) }))}</small>`;
        }
        // Con rampas o ascensores, el tramo se cuenta en orden: andando hasta el primero, el
        // elemento, andando hasta el siguiente… y el último trozo con el texto de siempre (49–51).
        const segs = walkSegs(j, k);
        if (segs.some((x) => x.used)) steps.push(walkPieceSteps(segs, textFor, tight, !!l.transfer));
        else steps.push(`<li class="step walk"><span class="ico">${ICON_WALK}</span>
          <span class="txt">${esc(text)}<small>${esc(hMin(walkMin(l.m)))}</small>${tight}</span></li>`);
        if (l.m >= 8) steps.push(shutItem(walkRoute(...walkEnds(j, k)).shut));
      } else {
        const ln = lines[l.line];
        const dest = ln && ln.sentidos[l.dir] ? ln.sentidos[l.dir].destino : "";
        const rideMin = Math.max(1, Math.round((l.arr - l.dep) / 60));
        const where = l.live ? ` <span class="bus-pos" data-bus="${esc(busKey(l))}"></span>` : "";
        const lc = `style="--lc:${ln ? ln.color : "var(--ink)"}"`;
        const pat = lastTrip.plan.pats[l.pat];
        const mids = pat ? pat.p.slice(l.from + 1, l.to).map((i) => `<li>${esc(stopName(i))}</li>`).join("") : "";
        steps.push(`<li class="step bus" ${lc}><span class="ico">${badge(l.line)}</span>
          <span class="txt"><b>${esc(stopName(l.board))}</b> <span class="gid">· ${esc(t("stop_lc", { id: lastTrip.plan.ids[l.board] }))}</span>
            <small class="dest">${esc(t("towards", { dest }))}</small>
            <small class="st">${statusHtml(l)}${where}${l.doubtful ? ` · <span class="warn">${esc(t("no_live"))}</span>` : ""}</small></span>
          <span class="tm">${esc(clock(l.dep))}</span></li>`);
        steps.push(`<li class="step ride" ${lc}><span class="ico"><i></i></span><span class="txt">
          ${mids ? `<button type="button" class="ride-btn" aria-expanded="false">` : `<span class="ride-btn">`}${esc(t(l.stops === 1 ? "stops_1" : "stops_n", { n: l.stops, min: rideMin }))}${mids ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button><ol class="ride-stops" hidden>${mids}</ol>` : "</span>"}</span></li>`);
        steps.push(`<li class="step alight" ${lc}><span class="ico"><i></i></span><span class="txt"><b>${esc(t("step_alight", { stop: stopName(l.alight) }))}</b></span><span class="tm">${esc(clock(l.arr))}</span></li>`);
      }
    });
    steps.push(ptRow("b", endLabel(trip.b), j.arr));
    const total = tripMin(j);
    const lt0 = leaveText(j, !!lt.arriveBy);
    const leave = lt0 ? `<span class="leave">${esc(lt0)}</span>` : "";
    const late = lt.arriveBy && j.late ? `<p class="trip-note"><span class="warn">${esc(t("arrive_late_live"))}</span></p>` : "";
    return `${back}<div class="opt-head"><span class="chain">${chain(j)}</span><span class="opt-time">${leave}<span class="eta">${durHtml(total)}</span></span>${acts}</div>${late}
      <ol class="steps">${steps.join("")}</ol>`;
  }

  // ---------- Opciones: mapa ----------
  function walkRoute(from, to) {
    const k = `${fmtLL(from)}|${fmtLL(to)}`;
    if (!walkCache.has(k)) {
      const r = lastTrip.net.route(from, to);
      let segs = [];
      if (r) {
        // Lo que se anda desde el punto pedido hasta la calle, en el primer y el último trozo.
        segs = (r.segs || []).map((x) => ({ ...x }));
        if (segs.length) { segs[0].real += r.offFrom; segs[0].eq += r.offFrom; const z = segs[segs.length - 1]; z.real += r.offTo; z.eq += r.offTo; }
      }
      walkCache.set(k, r ? { pts: [from, ...r.coords, to], dist: r.dist + r.offFrom + r.offTo, parts: r.parts || [], segs, shut: shutOn(from, to, r) } : { pts: [from, to], dist: null, parts: [], segs: [], shut: [] });
      if (walkCache.size > 200) walkCache.delete(walkCache.keys().next().value);
    }
    return walkCache.get(k);
  }
  const walkPath = (from, to) => walkRoute(from, to).pts;
  // Rampas, escaleras o ascensores que acortarían este camino pero están parados a la hora del
  // viaje (p. ej. un ascensor de noche): se avisa en los pasos para que no parezca un fallo (54).
  function shutOn(from, to, r) {
    const net = lastTrip.net, when = lastTrip.vvWhen;
    if (!net.vertical || !net.vertical.length || !when) return [];
    const closed = new Set(net.vertical.filter((el) => !PLAN.openAt(net.horarios, el, when)));
    if (!closed.size) return [];
    net.setVertical(() => true);
    const alt = net.route(from, to);
    setVerticalTime(net, when);
    if (!alt || alt.eq > r.eq - 40) return [];
    return [...new Set(alt.parts.filter((p) => p.used && closed.has(p.el)).map((p) => p.el.n))];
  }
  const shutItem = (names) => names.map((n) => `<li class="step vv shut"><span class="ico">${ICON_VV}</span>
    <span class="txt"><small>${esc(t("vv_closed", { name: n }))}</small></span></li>`).join("");
  // Extremos del tramo a pie k de una opción, y sus metros reales (l.m es el tiempo: metros
  // equivalentes con las cuestas).
  function walkEnds(j, k) {
    const llOf = (i) => byId.get(lastTrip.plan.ids[i]).ll;
    return [k === 0 ? trip.a.ll : llOf(j.legs[k - 1].alight), k === j.legs.length - 1 ? trip.b.ll : llOf(j.legs[k + 1].board)];
  }
  // Metros andando de verdad: sin el largo de las rampas, escaleras mecánicas o ascensores usados.
  function walkReal(j, k) {
    const l = j.legs[k];
    if (l.m < 8) return l.m;
    const w = walkRoute(...walkEnds(j, k));
    if (w.dist == null) return l.m;
    return Math.max(0, w.dist - w.parts.filter((p) => p.used).reduce((a, p) => a + (p.el.L || 0), 0));
  }
  const walkVV = (j, k) => (j.legs[k].m < 8 ? [] : walkRoute(...walkEnds(j, k)).parts.filter((p) => p.used));
  const walkSegs = (j, k) => (j.legs[k].m < 8 ? [] : walkRoute(...walkEnds(j, k)).segs);
  // Pasos de Vigo Vertical (como un modo de transporte más): los tramos seguidos de un mismo
  // elemento (p. ej. las 5 rampas de Gran Vía) van en un solo paso.
  const ICON_VV = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M12 6.5l2.6 3h-5.2zM12 17.5l2.6-3h-5.2z"/></svg>';
  const ICON_RAMP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19h4l10-10h4"/><path d="M14 5h5v5"/></svg>';
  function vvItem(g) {
    const lift = g.t === "ascensor" || g.t === "inclinado";
    const n = Math.max(1, Math.round(g.m / 75));
    return `<li class="step vv"><span class="ico">${lift ? ICON_VV : ICON_RAMP}</span>
      <span class="txt"><b>${esc(g.name)}</b><small>${esc(t("vv_ride", { type: t(`vv_${g.t}`), dir: t(g.up ? "vv_up" : "vv_down"), n }))}</small></span></li>`;
  }
  // Pasos de un tramo a pie que usa Vigo Vertical, en el orden del camino (segs de PV_PEATON.route):
  // "Anda X hasta <elemento>", el elemento, … y el último trozo con lastText(metros). Los tramos
  // seguidos de un mismo elemento (p. ej. las rampas de Gran Vía), con menos de VV_JOIN_M andando
  // entre ellos, van en un solo paso. Los trozos a pie de menos de 30 m no se cuentan.
  const VV_JOIN_M = 60;
  function walkPieceSteps(segs, lastText, extra = "", keepLast = false) {
    const ps = [];
    for (const x of segs) {
      const last = ps[ps.length - 1], prev = ps[ps.length - 2];
      if (x.walk || !x.used) {
        if (last && last.walk) { last.real += x.real; last.eq += x.eq; } else ps.push({ walk: true, real: x.real, eq: x.eq });
        continue;
      }
      if (last && !last.walk && last.name === x.el.n && last.up === x.up) { last.m += x.eq; continue; }
      if (last && last.walk && last.real < VV_JOIN_M && prev && !prev.walk && prev.name === x.el.n && prev.up === x.up) {
        ps.pop(); prev.m += last.eq + x.eq; continue;
      }
      ps.push({ name: x.el.n, t: x.el.t, up: x.up, m: x.eq });
    }
    if (!ps.length || !ps[ps.length - 1].walk) ps.push({ walk: true, real: 0, eq: 0 });
    return ps.map((p, i) => {
      if (!p.walk) return vvItem(p);
      const isLast = i === ps.length - 1;
      if (p.real < 30 && !(isLast && (keepLast || extra))) return "";
      const text = isLast ? lastText(p.real) : t("step_walk_to", { dist: fmtDist(p.real), place: ps[i + 1].name });
      return `<li class="step walk"><span class="ico">${ICON_WALK}</span>
        <span class="txt">${esc(text)}${p.real >= 30 ? `<small>${esc(hMin(walkMin(p.eq)))}</small>` : ""}${isLast ? extra : ""}</span></li>`;
    }).join("");
  }
  // Trazado de un tramo en bus. Muchos recorridos mezclan el trazado principal de la línea y algún
  // ramal (p. ej. los viajes de la 18A que empiezan en Rúa do Areal), así que cada trozo entre
  // paradas se dibuja con el trazado que pasa por ellas (a menos de 60 m), alargándolo todo lo
  // posible; si ninguno pasa, en línea recta. Así siempre empieza y acaba en sus paradas.
  const ON_SHAPE = 60;
  function busPath(leg) {
    const plan = lastTrip.plan;
    const pt = plan.pats[leg.pat];
    return pathThrough(lines[pt.l].sentidos[pt.s], pt.p.map((i) => plan.ids[i]), leg.from, leg.to, `p${pt.n}`);
  }
  // Recorrido de un sentido de línea pasando por una lista de paradas (ids), de la posición "from" a
  // la "to": cada trozo con el trazado (principal o ramal) que pasa por sus paradas.
  const pathCache = new Map();
  function pathThrough(dir, ids, from = 0, to = ids.length - 1, key = null) {
    const k = key || ids.join(",");
    if (!pathCache.has(k)) {
      const lls = ids.map((id) => byId.get(id).ll);
      const shapes = [dir.trazado, ...(dir.ramales || [])].map((enc) => {
        const sh = BUS.prepare(BUS.decode(enc));
        const r = BUS.stopsAlong(sh, lls);
        return { sh, along: r.map((x) => x.along), off: r.map((x) => x.off) };
      });
      pathCache.set(k, { shapes, lls });
      if (pathCache.size > 300) pathCache.delete(pathCache.keys().next().value);
    }
    const { shapes, lls } = pathCache.get(k);
    const out = [];
    const leg = { to };
    let kk = from;
    while (kk < leg.to) {
      let best = null;
      for (const s of shapes) {
        let e = kk;
        while (e < leg.to && s.off[e] <= ON_SHAPE && s.off[e + 1] <= ON_SHAPE && s.along[e + 1] >= s.along[e]) e++;
        if (e > kk && (!best || e > best.e)) best = { s, e };
      }
      if (best) {
        if (!out.length) out.push(lls[kk]);   // desde la propia parada
        out.push(...BUS.slice(best.s.sh, best.s.along[kk], best.s.along[best.e]));
        kk = best.e;
      } else {
        out.push(lls[kk], lls[kk + 1]);
        kk++;
      }
    }
    out.push(lls[leg.to]);                   // hasta la propia parada
    return out;
  }
  const walkStyle = (pts) => [
    L.polyline(pts, { renderer, color: "#FFFFFF", weight: 10, opacity: 0.95, interactive: false, lineCap: "round", lineJoin: "round" }),
    L.polyline(pts, { renderer, color: "#1C6FA8", weight: 6, opacity: 1, interactive: false, lineCap: "round", lineJoin: "round", dashArray: "0.1 10" }),
  ];

  // Dibuja la opción elegida (o la primera de la lista) y sus buses en camino.
  function drawTrip(fit) {
    const lt = lastTrip;
    tripLayer.clearLayers();
    tripBuses.forEach((b) => { if (b.marker) b.marker.remove(); if (b.tail) b.tail.forEach((x) => x.remove()); });
    tripBuses = [];
    clearInterval(tripTick);
    tripRouteOn = !!lt;
    updateStopVisibility();
    if (!lt) return;
    const shown = shownKey();
    const all = [trip.a.ll, trip.b.ll];
    if (shown === "walk") {
      if (!lt.walk) { if (fit) fitPoints(all, 17); return; }
      const r = lt.walk.r;
      const thin = { renderer, color: "#1C6FA8", weight: 2.5, opacity: 0.8, dashArray: "3 6", interactive: false };
      if (r.offFrom > 4) L.polyline([trip.a.ll, r.from], thin).addTo(tripLayer);
      if (r.offTo > 4) L.polyline([r.to, trip.b.ll], thin).addTo(tripLayer);
      walkStyle(r.coords).forEach((p) => p.addTo(tripLayer));
      if (fit) fitPoints([...r.coords, ...all], 17);
      return;
    }
    const j = lt.opts.find((o) => o.key === shown);
    if (!j) return;
    const plan = lt.plan;
    const llOf = (i) => byId.get(plan.ids[i]).ll;
    j.legs.forEach((l, k) => {
      if (l.type !== "walk") return;
      const from = k === 0 ? trip.a.ll : llOf(j.legs[k - 1].alight);
      const to = k === j.legs.length - 1 ? trip.b.ll : llOf(j.legs[k + 1].board);
      if (l.m < 8) return;
      const pts = walkPath(from, to);
      walkStyle(pts).forEach((p) => p.addTo(tripLayer));
      all.push(...pts);
    });
    j.legs.forEach((l) => {
      if (l.type !== "bus") return;
      const ln = lines[l.line];
      const pts = busPath(l);
      L.polyline(pts, { renderer, color: "#13222C", weight: 11, opacity: 0.35, interactive: false }).addTo(tripLayer);
      L.polyline(pts, { renderer, color: "#FFFFFF", weight: 9, opacity: 1, interactive: false }).addTo(tripLayer);
      L.polyline(pts, { renderer, color: ln.color, weight: 6, opacity: 1, interactive: false, lineCap: "round" }).addTo(tripLayer);
      // Paradas del tramo: las intermedias, pequeñas; la de subida y la de bajada, más grandes.
      const pt = plan.pats[l.pat];
      for (let k = l.from + 1; k < l.to; k++) {
        L.circleMarker(llOf(pt.p[k]), { renderer, radius: 3.5, weight: 2.5, color: ln.color, fillColor: "#FFFFFF", fillOpacity: 1, interactive: false }).addTo(tripLayer);
      }
      [l.board, l.alight].forEach((i) => L.circleMarker(llOf(i), { renderer, radius: 6.5, weight: 4, color: ln.color, fillColor: "#FFFFFF", fillOpacity: 1, interactive: false }).addTo(tripLayer));
      all.push(...pts);
      // Bus en camino hacia la parada de subida (con dato en vivo).
      if (l.live && isFinite(Number(l.live.metros))) {
        const dir = ln.sentidos[l.dir];
        const loc = BUS.locateStop(dir, plan.ids[l.board], (id) => (byId.get(id) || {}).ll || [0, 0]);
        if (loc) tripBuses.push({ key: busKey(l), loc, est: l.live, at: l.live._at, color: ln.color, texto: ln.texto });
      }
    });
    drawTripBuses();
    if (tripBuses.length) tripTick = setInterval(drawTripBuses, 1000);
    else tripTick = setInterval(() => { if (lastTrip && !trip.sel) renderTripResult(); }, 15000);   // "pasa en N min" al día
    if (fit) fitPoints(all, 17);
  }

  // Bus que aún no ha salido de cabecera (tareas 38 y 44): la API ya lo da con los minutos que
  // faltan, pero está esperando en la primera parada (o terminando el viaje anterior). Sin esto se
  // dibujaba avanzando desde que llegaba el dato. Se mira el dato tal como llegó: si lo pone a menos
  // de HEAD_M del principio del recorrido (o antes de él), el bus se queda quieto en la cabecera,
  // con "Cabecera" en vez de los minutos y todo el recorrido hasta tu parada. Solo en el trazado
  // principal y no en las circulares (allí antes de la cabecera está la vuelta anterior).
  const HEAD_M = 150;
  function busState(b) {
    const s = BUS.busAt(b.loc, b.est, (Date.now() - b.at) / 60000);
    if (b.loc.circular || b.loc.branch !== -1) return s;
    const s0 = BUS.busAt(b.loc, b.est, 0);
    if (!s0 || (s0.state === "route" && s0.d >= HEAD_M)) return s;
    return { state: "head", d: 0, left: b.loc.along, ...BUS.pointAt(b.loc.shape, 0) };
  }
  function drawTripBuses() {
    tripBuses.forEach((b) => {
      const s = busState(b);
      // En los pasos: a qué distancia va el bus de la parada.
      const span = document.querySelector(`#trip-result .bus-pos[data-bus="${CSS.escape(b.key)}"]`);
      if (span) span.textContent = s && s.state === "route" ? `· ${t("bus_far", { dist: fmtDist(s.left) })}` : s && (s.state === "depot" || s.state === "head") ? `· ${t("bus_depot")}` : "";
      if (!s || (s.state !== "route" && s.state !== "head")) {
        if (b.marker) { b.marker.remove(); b.marker = null; }
        if (b.tail) { b.tail.forEach((x) => x.remove()); b.tail = null; }
        return;
      }
      if (!b.marker) b.marker = busMarker(b.color, b.texto, s.ll);
      placeBus(b.marker, s, b.est, b.at);
      if (s.state === "head") { const el = b.marker.getElement(); if (el) el.querySelector(".bus-eta").textContent = t("bus_head"); }
      // Lo que le queda por recorrer hasta la parada de subida: mismo color, más clarito.
      const sh = b.loc.shape;
      const pts = s.d <= b.loc.along ? BUS.slice(sh, s.d, b.loc.along)
        : [...BUS.slice(sh, s.d, sh.length), ...BUS.slice(sh, 0, b.loc.along)];   // circular: termina la vuelta
      if (!b.tail) {
        b.tail = [
          L.polyline(pts, { renderer: tailRenderer, color: "#FFFFFF", weight: 8, opacity: 0.9, interactive: false, lineCap: "round", lineJoin: "round" }),
          L.polyline(pts, { renderer: tailRenderer, color: b.color, weight: 5, opacity: 0.45, interactive: false, lineCap: "round", lineJoin: "round" }),
        ];
        b.tail.forEach((x) => x.addTo(map));
      } else b.tail.forEach((x) => x.setLatLngs(pts));
    });
  }

  // Elegir una opción (entra en el historial: el botón Atrás del móvil vuelve a la lista).
  $("#trip-result").addEventListener("click", (e) => {
    const star = e.target.closest("button[data-star]");
    if (star && lastTrip) { e.stopPropagation(); toggleTripFav(star.dataset.star); return; }
    if (e.target.closest("[data-opt-back]")) { goBack(); return; }
    const rb = e.target.closest("button.ride-btn");
    if (rb) {
      const open = rb.getAttribute("aria-expanded") !== "true";
      rb.setAttribute("aria-expanded", open);
      rb.nextElementSibling.hidden = !open;
      return;
    }
    if (e.target.closest("[data-tfshare]")) { $('[data-share="trip"]').click(); return; }
    const b = e.target.closest("button[data-opt]");
    if (!b || !lastTrip) return;
    trip.sel = b.dataset.opt;
    history.pushState({ d: ((history.state && history.state.d) || 0) + 1, opt: trip.sel }, "", location.href);
    renderTripResult();
    drawTrip(true);
    $("#trip-result").scrollTop = 0;
  });

  map.on("click", (e) => {
    if (!tripOpen() || justHeld() || e.originalEvent._stopHit) return;
    // Si se toca un número de portal, se elige esa dirección; si no, el punto del mapa.
    const pt = numAt(e.containerPoint);
    if (pt) setEnd(targetEnd(), { kind: "addr", ll: pt.ll, label: `${pt.s.name}, ${pt.n}` });
    else setEnd(targetEnd(), { kind: "map", ll: [e.latlng.lat, e.latlng.lng] });
  });

  // ---------- "Desde aquí / Hasta aquí" en cualquier punto del mapa (32) ----------
  // Móvil: mantener pulsado; ordenador: botón derecho. Un menú pequeño en ese punto (con la
  // dirección si hay un portal a menos de 40 m) para usarlo como origen o destino de Cómo llegar.
  const hereMenu = L.popup({ closeButton: false, className: "here-pop", autoPanPaddingTopLeft: [16, 16], autoPanPaddingBottomRight: [16, 16] });
  let herePoint = null;
  function nearestAddr(ll) {
    if (!dirData) return null;
    const d = 0.0005;
    let best = null, bd = 40;
    for (const pt of dirData.portalsIn(ll[0] - d, ll[1] - d * 1.35, ll[0] + d, ll[1] + d * 1.35)) {
      const m = haversine(ll, pt.ll);
      if (m < bd) { bd = m; best = pt; }
    }
    return best ? { kind: "addr", ll: best.ll, label: `${best.s.name}, ${best.n}` } : null;
  }
  function openHereMenu(latlng) {
    const ll = [latlng.lat, latlng.lng];
    if (waterAt(ll)) { toast(t("in_water")); return; }
    const fill = () => {
      herePoint = nearestAddr(ll) || { kind: "map", ll };
      herePoint.at = ll;
      const box = L.DomUtil.create("div", "here");
      box.innerHTML = `<small>${esc(herePoint.kind === "addr" ? herePoint.label : t("map_point"))}</small>
        <button type="button" data-here="a"><span class="pin pin-a">A</span>${esc(t("here_from"))}</button>
        <button type="button" data-here="b"><span class="pin pin-b">B</span>${esc(t("here_to"))}</button>`;
      L.DomEvent.disableClickPropagation(box);
      box.addEventListener("click", (e) => { const b = e.target.closest("[data-here]"); if (b) useHere(b.dataset.here); });
      hereMenu.setLatLng(latlng).setContent(box);
      if (!map.hasLayer(hereMenu)) hereMenu.openOn(map);
    };
    fill();
    if (!dirData) ensureDir().then(() => { if (map.hasLayer(hereMenu) && herePoint && herePoint.at === ll) fill(); }).catch(() => {});
  }
  function useHere(which) {
    const p = herePoint && { kind: herePoint.kind, ll: herePoint.ll, label: herePoint.label };
    map.closePopup(hereMenu);
    if (!p) return;
    if (p.kind !== "addr") delete p.label;
    if (tripOpen()) { setEnd(which, p); return; }
    if (p.kind === "map") { onLand(p.ll).then((ok) => { if (ok) startHere(which, p); }); return; }
    startHere(which, p);
  }
  function startHere(which, p) {
    // Fuera de Cómo llegar: un viaje nuevo (con "Mi ubicación" como origen si se elige el destino).
    trip.a = trip.b = null;
    trip.sel = null;
    trip[which] = p;
    if (which === "b" && me && !farFromVigo(me)) trip.a = { kind: "me", ll: me };
    navigate(`ir/${endToken(trip.a)}/${endToken(trip.b)}`.replace(/\/+$/, ""));
  }
  // Ordenador (y algunos móviles, que lo lanzan al mantener pulsado): botón derecho.
  map.on("contextmenu", (e) => { if (justHeld()) return; heldAt = Date.now(); openHereMenu(e.latlng); });
  // Móvil: pulsación larga propia (no todos los navegadores lanzan "contextmenu"), sin moverse.
  {
    let timer = null, x0 = 0, y0 = 0;
    const el = map.getContainer();
    const cancel = () => { clearTimeout(timer); timer = null; };
    el.addEventListener("touchstart", (e) => {
      cancel();
      if (e.touches.length !== 1 || e.target.closest(".leaflet-popup, .leaflet-control")) return;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
      timer = setTimeout(() => {
        timer = null;
        heldAt = Date.now();
        const r = el.getBoundingClientRect();
        openHereMenu(map.containerPointToLatLng([x0 - r.left, y0 - r.top]));
        if (navigator.vibrate) try { navigator.vibrate(15); } catch { /* sin vibración */ }
      }, 550);
    }, { passive: true });
    el.addEventListener("touchmove", (e) => { if (timer && Math.hypot(e.touches[0].clientX - x0, e.touches[0].clientY - y0) > 10) cancel(); }, { passive: true });
    el.addEventListener("touchend", cancel, { passive: true });
    el.addEventListener("touchcancel", cancel, { passive: true });
  }

  ["a", "b"].forEach((w) => {
    const inp = $(`#trip-${w}`);
    inp.addEventListener("focus", () => {
      trip.picking = null;
      renderTripFields();
      openSugg(w);
      if (inp.dataset.keep) { delete inp.dataset.keep; inp.setSelectionRange(inp.value.length, inp.value.length); }
      else inp.select();
      if (!isDesktop()) panel.dataset.state = "full";
    });
    inp.addEventListener("input", () => openSugg(w));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = $("#trip-sugg button[data-site], #trip-sugg button[data-addr], #trip-sugg button[data-id]");
        if (first) first.click();
      }
      if (e.key === "Escape") { inp.value = endLabel(trip[w]); inp.blur(); closeSugg(); setPanel(baseState()); }
    });
  });
  // Tocar una sugerencia no quita el foco al campo (así se puede seguir escribiendo).
  $("#trip-sugg").addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
  $("#trip-sugg").addEventListener("click", (e) => {
    e.stopPropagation();   // aquí una parada no abre su ficha: se elige como origen o destino
    const w = trip.editing || targetEnd();
    const stop = e.target.closest("button[data-id]");
    if (e.target.closest("button[data-recent-clear]")) { recents = []; saveRecents(); openSugg(w); return; }
    if (stop) { addRecent({ id: stop.dataset.id }); setEnd(w, stopEnd(byId.get(stop.dataset.id))); return; }
    const rc = e.target.closest("button[data-recent]");
    if (rc) { const r = recents[Number(rc.dataset.recent)]; if (r) { addRecent(r); setEnd(w, { kind: "addr", ll: r.ll, label: r.label }); } return; }
    const si = e.target.closest("button[data-site]");
    if (si && sitesData) { const s = sitesData[Number(si.dataset.site)]; addRecent({ ll: s.ll, label: s.name, site: s.type }); setEnd(w, { kind: "addr", ll: s.ll, label: s.name }); return; }
    const ad = e.target.closest("button[data-addr]");
    if (ad && dirData) {
      const st = dirData.streets[Number(ad.dataset.addr)];
      const inp = $(`#trip-${w}`);
      if (ad.dataset.fill) {
        // Calle sin número: se completa el campo para escribir el número a continuación.
        inp.value = `${st.name}, `;
        inp.dataset.keep = "1";
        inp.focus();
        delete inp.dataset.keep;
        inp.setSelectionRange(inp.value.length, inp.value.length);
        openSugg(w);
        return;
      }
      const num = ad.dataset.num;
      const r = dirData.resolve(st, num);
      addRecent({ ll: r.ll, label: num ? `${st.name}, ${num}` : st.name });
      setEnd(w, { kind: "addr", ll: r.ll, label: num ? `${st.name}, ${num}` : st.name, approx: !r.exact && !!num });
      return;
    }
    const sp = e.target.closest("button[data-trip]");
    if (!sp) return;
    if (sp.dataset.trip === "me") {
      getPosition((ll) => setEnd(w, { kind: "me", ll }), () => {
        // Lejos de Vigo: no se usa como origen ni destino y el mapa se queda donde está.
        const inp = $(`#trip-${w}`);
        inp.value = endLabel(trip[w]);
        inp.blur();
        closeSugg();
        renderTripFields();
        setPanel(baseState());
        toast(t("geo_far_trip"));
      });
    } else {
      // Elegir en el mapa: el siguiente toque en el mapa marca el punto.
      $(`#trip-${w}`).blur();
      closeSugg();
      trip.picking = w;
      renderTripFields();
      setPanel("min");
      toast(t("pick_map_hint"));
    }
  });
  document.querySelectorAll("[data-clear]").forEach((b) => b.addEventListener("click", () => {
    const w = b.dataset.clear;
    trip[w] = null;
    tripReplace();
    $(`#trip-${w}`).value = "";
    renderTripFields();
    computeTrip(false);
    $(`#trip-${w}`).focus();
  }));
  $("#trip-swap").addEventListener("click", () => {
    [trip.a, trip.b] = [trip.b, trip.a];
    tripReplace();
    renderTripFields();
    computeTrip(false);
  });
  // Hora de salida: "Salir ahora" o una hora concreta (hasta 7 días después).
  const localISO = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  function renderWhen() {
    const inp = $("#when-at");
    const later = !!trip.when;
    $("#when-now").setAttribute("aria-pressed", !later);
    $("#when-dep").setAttribute("aria-pressed", later && trip.whenMode !== "arr");
    $("#when-arr").setAttribute("aria-pressed", later && trip.whenMode === "arr");
    $("#when-text").textContent = whenLabel(later ? trip.when : new Date());
    if (later) inp.value = localISO(trip.when);
    else if (document.activeElement !== inp) inp.value = "";
    // Cabecera de las opciones (mockup 1): "Salir: ahora" / "Llegar: hoy, 18:30".
    const chip = esc(t(later && trip.whenMode === "arr" ? "chip_arrive" : "chip_leave", { when: "\u0000" }));
    $("#trip-when-chip-text").innerHTML = chip.replace("\u0000", `<b>${esc(later ? whenLabel(trip.when) : t("now_lc"))}</b>`);
  }
  function whenLabel(d) {
    const time = d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / 86400000);
    if (day === 0) return t("when_today", { time });
    if (day === 1) return t("when_tomorrow", { time });
    return `${d.toLocaleDateString(lang, { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
  }
  // En el ordenador, tocar la hora abre el calendario del navegador (en el móvil ya lo hace el toque).
  $("#when-at").addEventListener("click", (e) => { try { e.target.showPicker(); } catch { /* no lo admite */ } });
  // Salir a las / Llegar a las: si aún no hay hora, se abre el selector para elegirla.
  ["dep", "arr"].forEach((m) => $(`#when-${m}`).addEventListener("click", () => {
    trip.whenMode = m;
    renderWhen();
    if (!trip.when) {
      const i = $("#when-at");
      i.focus();
      try { i.showPicker(); } catch { /* no lo admite */ }
      return;
    }
    trip.sel = null;
    tripReplace();
    computeTrip(false);
  }));
  // Cabecera de las opciones: la hora abre la fila de hora; la preferencia pasa a la siguiente.
  $("#trip-when-chip").addEventListener("click", () => {
    const open = !$("#trip").classList.contains("when-open");
    $("#trip").classList.toggle("when-open", open);
    $("#trip-when-chip").setAttribute("aria-expanded", open);
  });
  $("#trip-pref-chip").addEventListener("click", () => {
    const order = ["fast", "transfers", "walk"];
    const next = order[(order.indexOf(tripPref) + 1) % order.length];
    const b = document.querySelector(`#trip-pref [data-pref="${next}"]`);
    if (b) b.click();
  });
  $("#when-now").addEventListener("click", () => {
    if (!trip.when) return;
    trip.when = null;
    renderWhen();
    tripReplace();
    computeTrip(false);
  });
  $("#when-at").addEventListener("focus", (e) => {
    const now = new Date();
    e.target.min = localISO(now);
    e.target.max = localISO(new Date(now.getTime() + 7 * 86400000));
    if (!e.target.value) e.target.value = localISO(new Date(Math.ceil(now.getTime() / 900000) * 900000 + 900000));
  });
  // La hora elegida. También al cerrar el selector sin cambiar la hora propuesta al abrirlo (en el
  // móvil, aceptar esa hora no lanza "change") y al salir de él con otra hora escrita.
  function applyWhen(e) {
    const d = e.target.value ? new Date(e.target.value) : null;   // "AAAA-MM-DDTHH:MM" se lee como hora local
    const now = Date.now();
    const when = d && !isNaN(d) && d.getTime() > now + 60000 ? new Date(Math.min(d.getTime(), now + 7 * 86400000)) : null;
    if (when && trip.when && when.getTime() === trip.when.getTime()) return;
    if (!when && !trip.when) { renderWhen(); return; }
    trip.when = when;
    renderWhen();
    tripReplace();
    computeTrip(false);
  }
  $("#when-at").addEventListener("change", applyWhen);
  $("#when-at").addEventListener("blur", applyWhen);

  // Volver (junto al título): sale de "Cómo llegar" al menú principal de una vez, aunque se hayan
  // visto varios trayectos u opciones seguidos (cada uno queda en el historial del navegador).
  let toHome = false;
  $("#trip-back").addEventListener("click", () => {
    const d = (history.state && history.state.d) || 0;
    const steps = d - (tripEntryDepth == null ? d : tripEntryDepth) + 1;
    tripEntryDepth = null;
    if (steps > 0 && d - steps >= 0) { toHome = true; history.go(-steps); }
    else navigate("", { replace: true });
  });
  // Tras salir, si se ha vuelto a otra pantalla (p. ej. la parada desde la que se abrió), al inicio.
  addEventListener("popstate", () => {
    if (!toHome) return;
    toHome = false;
    if (location.hash && location.hash !== "#") navigate("", { replace: true });
  });
  $("#go-trip").addEventListener("click", () => { clearTimeout(qTimer); $("#q").blur(); openTrip(); });
  $("#trip-here").addEventListener("click", () => { if (current) openTrip(stopEnd(current)); });

  // ---------- Eventos ----------
  // Paradas y líneas se abren desde cualquier lista o chapa del panel.
  $("#panel").addEventListener("click", (e) => {
    const stop = e.target.closest("button[data-id]");
    // Abrir un resultado anula la búsqueda que estaba a punto de ejecutarse.
    if (stop || e.target.closest("button[data-line], button[data-addr], button[data-site]")) clearTimeout(qTimer);
    const fromSearch = mode === "search" || mode === "recent";
    if (e.target.closest("#list button[data-recent-clear]")) {
      recents = []; saveRecents(); $("#q").focus(); render(); return;
    }
    const rc = e.target.closest("#list button[data-recent]");
    if (rc) {
      const r = recents[Number(rc.dataset.recent)];
      if (!r) return;
      addRecent(r);
      $("#q").blur();
      openPlace({ ll: r.ll, label: r.label, approx: false, ...(r.site ? { site: r.site } : {}) });
      return;
    }
    // Sitio del buscador: su ficha (como una dirección), con su tipo.
    const si = e.target.closest("#list button[data-site]");
    if (si && sitesData) {
      const s = sitesData[Number(si.dataset.site)];
      addRecent({ ll: s.ll, label: s.name, site: s.type });
      $("#q").blur();
      openPlace({ ll: s.ll, label: s.name, approx: false, site: s.type });
      return;
    }
    // Dirección del buscador: sin número, se completa "Calle, " para escribirlo; con número, se abre.
    const ad = e.target.closest("#list button[data-addr]");
    if (ad && dirData) {
      const st = dirData.streets[Number(ad.dataset.addr)];
      if (ad.dataset.fill) {
        const q = $("#q");
        q.value = `${st.name}, `;
        q.focus();
        q.setSelectionRange(q.value.length, q.value.length);
        render();
        return;
      }
      const num = ad.dataset.num;
      const r = dirData.resolve(st, num);
      addRecent({ ll: r.ll, label: num ? `${st.name}, ${num}` : st.name });
      $("#q").blur();
      openPlace({ ll: r.ll, label: num ? `${st.name}, ${num}` : st.name, approx: !r.exact && !!num });
      return;
    }
    if (stop) { if (fromSearch && stop.closest("#list")) addRecent({ id: stop.dataset.id }); $("#q").blur(); navigate(stop.dataset.id); return; }
    const line = e.target.closest("button[data-line]");
    if (line) {
      $("#q").blur();
      // Si se abre desde una parada, la línea se muestra alrededor de esa parada y con su próximo bus.
      lineRuta = line.dataset.ruta || null;
      // Desde una parada, la fila abre solo los viajes con ese letrero (como una línea aparte).
      const ruta = current && line.dataset.raw;
      // Abierta desde la pantalla Líneas: la barra sigue marcando Líneas.
      lineTab = panel.dataset.view === "home" && mode === "lines" ? "lineas" : "";
      navigate(`linea/${line.dataset.line}${current ? `/${current.id}` : ""}${ruta ? `/${encodeURIComponent(ruta)}` : ""}`);
      return;
    }
    const dir = e.target.closest("button[data-dir]");
    if (dir && active) {
      active.dir = Number(dir.dataset.dir);
      $("#line-dirs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", b === dir));
      renderLineStops();
      drawLine();
      // Si este sentido también pasa por la parada de origen, se siguen sus buses.
      const d = lines[active.code].sentidos[active.dir];
      if (active.from && active.fromDir !== active.dir && (d.paradas.includes(active.from) || (d.otras || []).includes(active.from))) {
        active.fromDir = active.dir;
        startTrack();
      }
      startFleet();
      drawBus();
      renderBusCard();
    }
  });
  $("#back").addEventListener("click", goBack);
  $("#line-back").addEventListener("click", goBack);
  // Desde una variante, la línea completa (con sus dos sentidos y todos sus ramales).
  $("#line-whole").addEventListener("click", () => {
    if (!active) return;
    if (active.variant) { lineAllNext = true; navigate(`linea/${active.code}${active.from ? `/${active.from}` : ""}`); return; }
    active.all = true;
    renderLineStops();
  });
  $("#fav").addEventListener("click", () => {
    if (!current) return;
    const id = current.id;
    if (favStop(id)) favs.stops = favs.stops.filter((f) => f.id !== id);
    else favs.stops.push({ id, lines: null });
    saveFavs();
    updateFavBtn();
    refreshIcon(current);
    toast(favStop(id) ? t("fav_added") : t("fav_removed"));
  });
  $("#refresh").addEventListener("click", () => loadArrivals(false));
  // Tocar una pestaña muestra su contenido aunque quedara texto en el buscador.
  TABS.forEach((tab) => $(`#tab-${tab}`).addEventListener("click", () => { $("#q").value = ""; setTab(tab); }));
  $("#locate").addEventListener("click", locate);
  $("#map-back").addEventListener("click", goBack);
  $("#screen-back").addEventListener("click", goBack);
  // Capas del mapa en la botonera (58): lista a la derecha del botón, como la de idiomas.
  const renderLayerSeg = () => document.querySelectorAll("#fab-layer-menu [data-layer]").forEach((b) => b.parentElement.setAttribute("aria-selected", b.dataset.layer === baseLayer));
  function toggleFabLayer(open) {
    const menu = $("#fab-layer-menu"), btn = $("#fab-layer");
    const show = open != null ? open : menu.hidden;
    menu.hidden = !show;
    btn.setAttribute("aria-expanded", show);
    if (!show) return;
    if (typeof toggleFabLang === "function") toggleFabLang(false);
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.round(r.right + 8)}px`;
    menu.style.bottom = `${Math.round(innerHeight - r.bottom)}px`;
    (menu.querySelector('[aria-selected="true"] button') || menu.querySelector("button")).focus();
  }
  $("#fab-layer").addEventListener("click", (e) => { e.stopPropagation(); toggleFabLayer(); });
  $("#fab-layer-menu").addEventListener("click", (e) => {
    const b = e.target.closest("[data-layer]");
    if (!b) return;
    e.stopPropagation();
    toggleFabLayer(false);
    $("#fab-layer").focus();
    if (b.dataset.layer !== baseLayer) { setBaseLayer(b.dataset.layer); renderLayerSeg(); }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#fab-layer-menu, #fab-layer")) toggleFabLayer(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#fab-layer-menu").hidden) { toggleFabLayer(false); $("#fab-layer").focus(); } });
  renderLayerSeg();
  if (baseLayer === "sat") setBaseLayer("sat");
  // Bordes del mapa difuminados (mockups): la de abajo sigue a la hoja cuando sube o baja.
  const fadeAt = () => document.documentElement.style.setProperty("--sheet-top", `${Math.round(panel.getBoundingClientRect().top)}px`);
  if (window.ResizeObserver) new ResizeObserver(fadeAt).observe(panel);
  panel.addEventListener("transitionend", fadeAt);
  addEventListener("resize", fadeAt);
  fadeAt();
  $("#map-share").addEventListener("click", () => $('[data-share="line"]').click());
  $("#map-full").addEventListener("click", () => setPanel(panel.dataset.state === "min" ? baseState() : "min"));
  $("#tf-share").addEventListener("click", () => $('[data-share="trip"]').click());
  $("#tf-star").addEventListener("click", () => { if (lastTrip && trip.sel) { toggleTripFav(trip.sel); syncTripScreen(); } });
  $("#fab-fav").addEventListener("click", () => navigate("favoritas"));
  // Ir a casa: el viaje hasta casa; si aún no está elegida, Favoritas para elegirla.
  $("#fab-home").addEventListener("click", () => { if (favs.home) goTo(favs.home); else navigate("favoritas"); });

  $("#q").addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { if (location.hash) navigate(""); else render(); }, 120);
  });
  $("#q").addEventListener("focus", () => {
    if (!isDesktop()) $("#panel").dataset.state = "full";
    if (!$("#q").value.trim() && !location.hash) render();
  });
  $("#q-clear").addEventListener("click", () => { $("#q").value = ""; $("#q").focus(); render(); });
  $("#q-cancel").addEventListener("click", () => {
    clearTimeout(qTimer);
    $("#q").value = "";
    $("#q").blur();
    mode = "near";
    if (location.hash) navigate(""); else render();
    if (!isDesktop()) panel.dataset.state = "peek";
  });
  // Al salir del buscador vacío, vuelve la pestaña. Tocar un reciente no quita el foco (mousedown).
  $("#q").addEventListener("blur", () => setTimeout(() => {
    if (mode === "recent" && document.activeElement !== $("#q")) { render(); if (!isDesktop() && panel.dataset.view === "home") panel.dataset.state = "peek"; }
  }, 150));
  $("#list").addEventListener("mousedown", (e) => { if (mode === "recent" && e.target.closest("button")) e.preventDefault(); });
  $("#q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // Resultados al día con lo escrito antes de abrir el primero.
      clearTimeout(qTimer);
      if (!location.hash) render();
      const first = $("#list button[data-id], #list button[data-line], #list button[data-site], #list button[data-addr]");
      if (first) first.click();
    }
    if (e.key === "Escape") { $("#q-cancel").click(); }
  });

  // Hoja inferior (móvil): deslizar hacia abajo la reduce hasta dejar casi todo el mapa a la vista;
  // hacia arriba la amplía. Tocar el asa alterna entre minimizada y normal.
  // En "Cómo llegar" con origen y destino, alto (como la ficha de parada) para ver las opciones.
  const baseState = () => (current || (tripOpen() && trip.a && trip.b) ? "stop" : "peek");
  function setPanel(state) {
    if (isDesktop()) return;
    panel.dataset.state = state;
    if (state !== "full") $("#q").blur();
  }
  $("#grip").addEventListener("click", () => setPanel(panel.dataset.state === "min" ? baseState() : "min"));
  let y0 = null, t0 = 0;
  panel.addEventListener("touchstart", (e) => {
    // Solo desde la cabecera del panel, para no interferir con el desplazamiento de las listas.
    if (!e.target.closest(".grip, .brand, .stop-head, .tabs, .dirs, .stop-foot")) { y0 = null; return; }
    y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  panel.addEventListener("touchend", (e) => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0;
    y0 = null;
    if (Math.abs(dy) < 30 || Date.now() - t0 > 800) return;
    const st = panel.dataset.state;
    if (dy > 0) setPanel(st === "full" ? baseState() : "min");
    else setPanel(st === "min" ? baseState() : "full");
  });
  // Tocar la cabecera con el panel minimizado lo vuelve a abrir.
  panel.addEventListener("click", (e) => {
    if (panel.dataset.state === "min" && !e.target.closest(".lang, .grip")) setPanel(baseState());
  }, true);
  panel.addEventListener("transitionend", () => map.invalidateSize());

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (current) loadArrivals(false);
    if (track) fetchTrack();
    if (fleet) fetchFleet();
    if (tripOpen() && lastTrip && lastTrip.plan && lastTrip.cands.length) { planSearch(); refreshLive(tripSeq); }
  });

  // ---------- Idioma: textos fijos y desplegable con banderas ----------
  function applyStatic() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
    document.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
    $("#lang-btn .flag").innerHTML = flagSvg(lang);
    $("#lang-code").textContent = (I18N.langs.find((l) => l.code === lang) || {}).name || lang.toUpperCase();
    // Botón del mapa: la bandera dentro de un círculo, como un globo, con borde blanco.
    $("#fab-lang").innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><clipPath id="fab-globe"><circle cx="12" cy="12" r="9"/></clipPath></defs>
      <g clip-path="url(#fab-globe)"><svg class="flagin" x="3" y="3" width="18" height="18" viewBox="0 0 30 20" preserveAspectRatio="xMidYMid slice">${flagSvg(lang)}</svg></g>
      <circle class="ring" cx="12" cy="12" r="9"/></svg>`;
    $("#fab-lang-menu").innerHTML = I18N.langs.map((l) =>
      `<li role="option" aria-selected="${l.code === lang}"><button type="button" data-lang="${l.code}" lang="${l.code}">
        <svg class="flag" viewBox="0 0 30 20" aria-hidden="true">${l.flag}</svg><span>${esc(l.name)}</span></button></li>`).join("");
    $("#lang-menu").innerHTML = I18N.langs.map((l) =>
      `<li role="option" aria-selected="${l.code === lang}"><button type="button" data-lang="${l.code}" lang="${l.code}">
        <svg class="flag" viewBox="0 0 30 20" aria-hidden="true">${l.flag}</svg><span>${esc(l.name)}</span></button></li>`).join("");
  }
  function toggleLangMenu(open) {
    const menu = $("#lang-menu");
    const show = open != null ? open : menu.hidden;
    menu.hidden = !show;
    $("#lang-btn").setAttribute("aria-expanded", show);
    if (show) (menu.querySelector('[aria-selected="true"] button') || menu.querySelector("button")).focus();
  }
  function setLang(code) {
    lang = code;
    try { localStorage.setItem(LANG_KEY, code); } catch { /* sin almacenamiento */ }
    applyStatic();
    // Volver a pintar lo que está a la vista con el idioma nuevo.
    if (current) {
      showStop(current.id, { repaint: true });
      if (lastArrivals) renderArrivals(lastArrivals);
      showUpdated();
    } else if (active) showLine(active.code, active.from, active.variant ? active.variant.ruta : null);
    else if (place) { document.title = APP_NAME; showPlace(); }
    else if (!$("#info").hidden) showInfo();
    else if (!$("#sched").hidden && sched) showSched(sched.id, sched.line);
    else if (tripOpen()) {
      renderTripFields();
      renderWhen();
      if (lastTrip) renderTripResult(); else computeTrip(false);
      document.title = `${t("trip_title")} · ${APP_NAME}`;
    }
    else render();
  }
  $("#lang-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleLangMenu(); });
  $("#lang-menu").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-lang]");
    if (!b) return;
    toggleLangMenu(false);
    $("#lang-btn").focus();
    if (b.dataset.lang !== lang) setLang(b.dataset.lang);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".lang")) toggleLangMenu(false); });
  // Acceso directo al idioma en los botones del mapa: la lista se abre a su derecha.
  function toggleFabLang(open) {
    const menu = $("#fab-lang-menu"), btn = $("#fab-lang");
    const show = open != null ? open : menu.hidden;
    menu.hidden = !show;
    btn.setAttribute("aria-expanded", show);
    if (!show) return;
    if (!$("#fab-layer-menu").hidden) toggleFabLayer(false);
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.round(r.right + 8)}px`;
    menu.style.bottom = `${Math.round(innerHeight - r.bottom)}px`;
    (menu.querySelector('[aria-selected="true"] button') || menu.querySelector("button")).focus();
  }
  $("#fab-lang").addEventListener("click", (e) => { e.stopPropagation(); toggleFabLang(); });
  $("#fab-lang-menu").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-lang]");
    if (!b) return;
    e.stopPropagation();
    toggleFabLang(false);
    $("#fab-lang").focus();
    if (b.dataset.lang !== lang) setLang(b.dataset.lang);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#fab-lang-menu, #fab-lang")) toggleFabLang(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#fab-lang-menu").hidden) { toggleFabLang(false); $("#fab-lang").focus(); } });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#lang-menu").hidden) { toggleLangMenu(false); $("#lang-btn").focus(); }
  });
  applyStatic();

  // ---------- App instalable ----------
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  // Botón "Instala la app": solo en el móvil, nunca si ya se usa como app ni si se cerró con la X.
  // Android (Chrome, Edge, Samsung…): abre la instalación del navegador (beforeinstallprompt).
  // iPhone: la web no puede instalarse sola; se explican los pasos de Safari (aprobado el 23/10).
  const IOS_INSTALL = true;
  const INSTALL_KEY = "pv:instalar-oculto";
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const onPhone = () => matchMedia("(pointer: coarse)").matches && !isDesktop();
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // Firefox en Android tampoco deja que la web abra la instalación: se explican los pasos de su menú.
  const isFirefoxAndroid = /Android/.test(navigator.userAgent) && /Firefox\//.test(navigator.userAgent);
  const manualSteps = () => (IOS_INSTALL && isIOS) || isFirefoxAndroid;
  let installEvt = null;
  function installHidden() { try { return localStorage.getItem(INSTALL_KEY) === "1"; } catch { return false; } }
  // "Más tarde": hasta que se vuelva a abrir la web (esta sesión del navegador).
  function installLater() { try { return sessionStorage.getItem(INSTALL_KEY) === "1"; } catch { return false; } }
  function showInstall() {
    const can = onPhone() && !standalone() && !installHidden() && !installLater() && (installEvt || manualSteps());
    $("#install").hidden = !can;
  }
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; showInstall(); });
  addEventListener("appinstalled", () => { installEvt = null; $("#install").hidden = true; });
  $("#install-btn").addEventListener("click", () => {
    if (installEvt) {
      const e = installEvt;
      e.prompt();
      e.userChoice.then((r) => { if (r.outcome === "accepted") { installEvt = null; $("#install").hidden = true; } }).catch(() => {});
    } else if (manualSteps()) {
      const ff = isFirefoxAndroid;
      $("#ios-install-title").textContent = t(ff ? "ff_title" : "ios_title");
      $("#ios-install .steps-ios").hidden = ff;
      $("#ios-install .steps-ff").hidden = !ff;
      $("#ios-install").hidden = false;
    }
  });
  $("#more-install").addEventListener("click", () => $("#install-btn").click());
  // Acerca de: qué es la web, de dónde salen los datos y quién la hace (cuando no hay que instalarla).
  $("#more-about").addEventListener("click", () => { $("#about-dialog").hidden = false; $("#about-ok").focus(); });
  $("#about-ok").addEventListener("click", () => { $("#about-dialog").hidden = true; $("#more-about").focus(); });
  $("#about-dialog").addEventListener("click", (e) => { if (e.target.id === "about-dialog") e.currentTarget.hidden = true; });
  $("#install-later").addEventListener("click", () => {
    try { sessionStorage.setItem(INSTALL_KEY, "1"); } catch { /* sin almacenamiento */ }
    $("#install").hidden = true;
  });
  $("#install-close").addEventListener("click", () => {
    try { localStorage.setItem(INSTALL_KEY, "1"); } catch { /* sin almacenamiento */ }
    $("#install").hidden = true;
  });
  $("#ios-install-ok").addEventListener("click", () => { $("#ios-install").hidden = true; });
  $("#ios-install").addEventListener("click", (e) => { if (e.target.id === "ios-install") e.currentTarget.hidden = true; });
  showInstall();
})();
