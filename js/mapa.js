// SPDX-License-Identifier: AGPL-3.0-only · © 2026 asergom · ver LICENSE y TERMINOS-ADICIONALES.md
// PV_MAPA: el "enchufe" del mapa (tareas 41 + 47). app.js habla solo con este objeto y nunca con
// Leaflet ni MapLibre directamente, para poder cambiar el motor del mapa sin tocar el resto de la
// web. La interfaz usa los nombres que ya usaba app.js (los de Leaflet: getZoom, getBounds,
// latLngToContainerPoint, on("click")…, con eventos que traen latlng, containerPoint y
// originalEvent) más unos constructores sencillos:
//   group(pane?)            → capa de trazos: line(pts, estilo), circle(ll, estilo), clear()
//   circle(ll, estilo)      → círculo suelto: setLatLng, setRadius, show, remove
//   marker(ll, opciones)    → marcador: setLatLng, getLatLng, show, remove, visible, getElement,
//                             setIcon, setOpacity, setZIndexOffset, on(click|dragend), tooltip
//   canvasPane(nombre, z)   → lienzo propio sobre el mapa: { canvas, place(mx, my) }
//   popup(opciones)         → globo: setLatLng, setContent, open, close, isOpen
//   fitPoints(pts, opciones), isMoving(), addAttribution(html), stopClicks(el)
//   startBase(tipo), setBase(tipo), waterAt(ll)   → mapa de fondo (claro, oscuro, satélite)
// Iconos de imagen como descriptores { url, size: [w, h], anchor: [x, y], className, key } y de
// HTML como { html, className, size, anchor }.
// Hoy solo existe el motor Leaflet (el de siempre, con el fondo de MapLibre debajo).
(function (root) {
  "use strict";

  const OFM = (n) => `https://tiles.openfreemap.org/styles/${n}`;
  const OFM_ATTR = '<a href="https://openfreemap.org/">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a>, datos de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const PNOA_URL = "https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0&format=image/jpeg&layer=OI.OrthoimageCoverage&style=default&tilematrixset=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}";
  const PNOA_ATTR = 'Ortofoto: <a href="https://pnoa.ign.es/">PNOA</a> cedido por © <a href="https://www.ign.es/">IGN</a>';
  const BASE_TIMEOUT = 8000;   // sin el fondo vectorial en este tiempo, OpenStreetMap

  function hasWebGL() {
    try { const c = document.createElement("canvas"); return !!(window.WebGL2RenderingContext && c.getContext("webgl2")) || !!c.getContext("webgl"); }
    catch { return false; }
  }
  const loadScript = (src) => new Promise((ok, ko) => {
    const el = document.createElement("script");
    el.src = src; el.onload = ok; el.onerror = ko;
    document.head.appendChild(el);
  });

  // ---------- Motor Leaflet ----------
  function leaflet(id, o) {
    const m = L.map(id, { zoomControl: false, preferCanvas: true, attributionControl: true }).setView(o.center, o.zoom);
    m.attributionControl.setPrefix(false);
    if (o.zoomControl) L.control.zoom({ position: "topleft" }).addTo(m);
    const box = m.getContainer();

    // Trazos: un lienzo compartido en el panel de siempre y uno por cada panel propio.
    const renderers = { "": L.canvas({ padding: 0.3, tolerance: 6 }) };
    const rendererFor = (pane) => {
      if (!pane) return renderers[""];
      if (!renderers[pane]) renderers[pane] = L.canvas({ padding: 0.3, pane });
      return renderers[pane];
    };
    const panes = new Set();
    function ensurePane(name, z) {
      if (panes.has(name)) return m.getPane(name);
      const p = m.createPane(name);
      p.style.zIndex = z;
      panes.add(name);
      return p;
    }

    const icons = new Map();   // clave del descriptor → L.Icon
    function toIcon(d) {
      if (d.html != null) return L.divIcon({ className: d.className || "", html: d.html, iconSize: d.size, ...(d.anchor ? { iconAnchor: d.anchor } : {}) });
      const k = d.key || d.url;
      if (!icons.has(k)) icons.set(k, L.icon({ iconUrl: d.url, iconSize: d.size, iconAnchor: d.anchor, className: d.className }));
      return icons.get(k);
    }
    const plain = (p) => ({ lat: p.lat, lng: p.lng });

    function wrapMarker(mk) {
      return {
        setLatLng(ll) { mk.setLatLng(ll); return this; },
        getLatLng() { return plain(mk.getLatLng()); },
        show() { if (!m.hasLayer(mk)) mk.addTo(m); return this; },
        remove() { mk.remove(); return this; },
        visible() { return m.hasLayer(mk); },
        getElement() { return mk.getElement(); },
        setIcon(d) { mk.setIcon(toIcon(d)); return this; },
        setOpacity(op) { mk.setOpacity(op); return this; },
        setZIndexOffset(z) { mk.setZIndexOffset(z); return this; },
        on(ev, fn) {
          if (ev === "dragend") mk.on("dragend", (e) => fn({ latlng: plain(e.target.getLatLng()) }));
          else mk.on(ev, fn);
          return this;
        },
        tooltip(fn, opts) { mk.bindTooltip(fn, opts); return this; },
      };
    }
    function wrapCircle(c) {
      return {
        setLatLng(ll) { c.setLatLng(ll); return this; },
        setRadius(r) { c.setRadius(r); return this; },
        show() { if (!m.hasLayer(c)) c.addTo(m); return this; },
        remove() { c.remove(); return this; },
      };
    }

    // Mapa de fondo: OpenFreeMap con MapLibre debajo de Leaflet (complemento oficial), o
    // OpenStreetMap si no hay WebGL o no carga; satélite con la ortofoto del IGN.
    let base = "light", osmLayer = null, glLayer = null, glReady = false, satLayer = null;
    function useOSM() {
      if (glLayer) { m.removeLayer(glLayer); glLayer = null; }
      box.classList.remove("gl-base");
      if (!osmLayer) osmLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, referrerPolicy: "strict-origin-when-cross-origin",
        attribution: '© <a href="https://www.openstreetmap.org/copyright">Colaboradores de OpenStreetMap</a>',
      });
      if (!m.hasLayer(osmLayer) && base !== "sat") osmLayer.addTo(m);
    }
    function setBase(kind) {
      base = kind;
      box.classList.toggle("sat-base", kind === "sat");
      box.classList.toggle("dark-base", kind === "dark");
      if (kind === "sat") {
        if (!satLayer) satLayer = L.tileLayer(PNOA_URL, { maxNativeZoom: 19, maxZoom: 20, attribution: PNOA_ATTR });
        if (!m.hasLayer(satLayer)) satLayer.addTo(m);
        satLayer.bringToBack();
        if (glLayer && glLayer.getContainer && glLayer.getContainer()) glLayer.getContainer().style.visibility = "hidden";
        if (osmLayer && m.hasLayer(osmLayer)) m.removeLayer(osmLayer);
        return;
      }
      if (satLayer && m.hasLayer(satLayer)) m.removeLayer(satLayer);
      if (glLayer) {
        if (glLayer.getContainer && glLayer.getContainer()) glLayer.getContainer().style.visibility = "";
        const gl = glLayer.getMaplibreMap();
        glReady = false;
        gl.setStyle(OFM(kind === "dark" ? "dark" : "positron"));
        gl.once("styledata", () => { glReady = true; });
      } else if (osmLayer && !m.hasLayer(osmLayer)) osmLayer.addTo(m);
    }
    async function startBase(kind) {
      base = kind;
      if (!hasWebGL()) { useOSM(); return; }
      const timer = setTimeout(() => { if (!glReady) useOSM(); }, BASE_TIMEOUT);
      try {
        const css = document.createElement("link");
        css.rel = "stylesheet"; css.href = "vendor/maplibre/maplibre-gl.css";
        document.head.appendChild(css);
        await loadScript("vendor/maplibre/maplibre-gl.js");
        await loadScript("vendor/maplibre/leaflet-maplibre-gl.js");
        if (osmLayer && m.hasLayer(osmLayer)) { clearTimeout(timer); return; }   // ya se pasó a OpenStreetMap
        glLayer = L.maplibreGL({ style: OFM(kind === "dark" ? "dark" : "positron"), attributionControl: { customAttribution: OFM_ATTR } }).addTo(m);
        const gl = glLayer.getMaplibreMap();
        gl.once("load", () => {
          glReady = true;
          clearTimeout(timer);
          box.classList.add("gl-base");
        });
        // Sin el estilo (OpenFreeMap caído o sin red), a OpenStreetMap; los fallos sueltos de una
        // tesela una vez cargado el mapa no cambian nada.
        gl.on("error", () => {
          // Sin el estilo oscuro de OpenFreeMap, su otro estilo oscuro ("fiord").
          if (base === "dark" && !glReady && !gl._pvFiord) { gl._pvFiord = true; gl.setStyle(OFM("fiord")); return; }
          if (!glReady) { clearTimeout(timer); useOSM(); }
        });
        if (base === "sat") setBase("sat");
      } catch {
        clearTimeout(timer);
        useOSM();
      }
    }
    // ¿Hay agua bajo este punto? true/false con el fondo vectorial; null si no se puede saber.
    function waterAt(ll) {
      if (!glReady || !glLayer) return null;
      try {
        const gl = glLayer.getMaplibreMap();
        const top = gl.queryRenderedFeatures(gl.project([ll[1], ll[0]])).find((f) => f.layer && f.layer.type === "fill");
        return !!top && top.sourceLayer === "water";
      } catch { return null; }
    }

    return {
      engine: "leaflet",
      getBearing: () => 0,
      resetNorth() { return this; },
      // Cámara y coordenadas
      getZoom: () => m.getZoom(),
      getCenter: () => m.getCenter(),
      getBounds: () => m.getBounds(),
      getSize: () => m.getSize(),
      getContainer: () => box,
      setView(ll, z, opts) { m.setView(ll, z, opts); return this; },
      fitPoints(pts, opts) { m.fitBounds(L.latLngBounds(pts), opts); return this; },
      project: (ll, z) => m.project(ll, z),
      unproject: (p, z) => m.unproject(L.point(p.x, p.y), z),
      latLngToContainerPoint: (ll) => m.latLngToContainerPoint(ll),
      containerPointToLatLng: (p) => m.containerPointToLatLng(p),
      invalidateSize() { m.invalidateSize(); return this; },
      isMoving: () => !!(m._animatingZoom || (m._panAnim && m._panAnim._inProgress)),
      on(ev, fn) { m.on(ev, fn); return this; },
      once(ev, fn) { m.once(ev, fn); return this; },
      addAttribution(html) { m.attributionControl.addAttribution(html); return this; },
      stopClicks(el) { L.DomEvent.disableClickPropagation(el); return this; },
      // Capas propias
      group(pane, z) {
        if (pane) ensurePane(pane, z);
        const g = L.layerGroup().addTo(m), r = rendererFor(pane);
        // Cada trazo se puede quitar suelto (sale también del grupo) o cambiar de puntos.
        const own = (x) => ({ remove() { g.removeLayer(x); return this; }, setLatLngs(pts) { x.setLatLngs(pts); return this; } });
        return {
          line: (pts, st) => own(L.polyline(pts, { renderer: r, interactive: false, ...st }).addTo(g)),
          circle: (ll, st) => own(L.circleMarker(ll, { renderer: r, interactive: false, ...st }).addTo(g)),
          clear() { g.clearLayers(); return this; },
        };
      },
      circle: (ll, st) => wrapCircle(L.circleMarker(ll, { renderer: renderers[""], interactive: false, ...st })),
      marker(ll, o) {
        const opts = { icon: toIcon(o.icon), keyboard: false };
        if (o.interactive === false) opts.interactive = false;
        if (o.draggable) opts.draggable = true;
        if (o.zIndexOffset) opts.zIndexOffset = o.zIndexOffset;
        if (o.alt != null) opts.alt = o.alt;
        return wrapMarker(L.marker(ll, opts));
      },
      canvasPane(name, z, cls) {
        const pane = ensurePane(name, z);
        pane.style.pointerEvents = "none";
        const canvas = L.DomUtil.create("canvas", cls, pane);
        // Coloca el lienzo con su esquina en el punto (-mx, -my) del contenedor.
        return { canvas, place: (mx, my) => L.DomUtil.setPosition(canvas, m.containerPointToLayerPoint([-mx, -my])) };
      },
      popup(o) {
        const p = L.popup(o);
        return {
          setLatLng(ll) { p.setLatLng(ll); return this; },
          setContent(el) { p.setContent(el); return this; },
          open() { if (!m.hasLayer(p)) p.openOn(m); return this; },
          close() { m.closePopup(p); return this; },
          isOpen: () => m.hasLayer(p),
        };
      },
      // Fondo
      startBase, setBase, waterAt,
    };
  }

  // ---------- Motor MapLibre (tareas 41 + 47; de momento solo con ?mapa=nuevo) ----------
  // Zoom: la web usa la escala de Leaflet (teselas de 256 px), una más que la de MapLibre; hacia
  // fuera se da entero (hacia abajo), como los niveles de Leaflet, para que valgan los umbrales.
  const ZOFF = 1;
  const PV = "pv-";   // prefijo de nuestras fuentes y capas (se conservan al cambiar de fondo)
  const OSM_STYLE = { version: 8, sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">Colaboradores de OpenStreetMap</a>' } },
    layers: [{ id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.15 } }] };
  const SAT_STYLE = { version: 8, sources: { pnoa: { type: "raster", tiles: [PNOA_URL], tileSize: 256, maxzoom: 19, attribution: PNOA_ATTR } },
    layers: [{ id: "pnoa", type: "raster", source: "pnoa" }] };
  const EMPTY_STYLE = { version: 8, sources: {}, layers: [] };
  // Letra de los textos (sitios): la de OpenFreeMap, también con los fondos que no la traen.
  const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
  [OSM_STYLE, SAT_STYLE, EMPTY_STYLE].forEach((st) => { st.glyphs = GLYPHS; });

  // Píxeles del "mundo" de Leaflet (EPSG:3857, 256 · 2^z), para project/unproject.
  const worldPx = (lat, lng, z) => {
    const s = 256 * 2 ** z, r = Math.PI / 180;
    const sin = Math.max(-0.9999, Math.min(0.9999, Math.sin(lat * r)));
    return { x: (lng + 180) / 360 * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s };
  };
  const worldLL = (p, z) => {
    const s = 256 * 2 ** z;
    const lng = p.x / s * 360 - 180;
    const n = Math.PI - 2 * Math.PI * p.y / s;
    return { lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng };
  };
  const toLL = (ll) => (Array.isArray(ll) ? { lat: ll[0], lng: ll[1] } : { lat: ll.lat, lng: ll.lng });
  const lngLat = (ll) => { const p = toLL(ll); return [p.lng, p.lat]; };
  function bounds(s, w, n, e) {
    return {
      _s: s, _w: w, _n: n, _e: e,
      getSouth: () => s, getWest: () => w, getNorth: () => n, getEast: () => e,
      contains(ll) { const p = toLL(ll); return p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e; },
      pad(f) { const dy = (n - s) * f, dx = (e - w) * f; return bounds(s - dy, w - dx, n + dy, e + dx); },
    };
  }

  function maplibre(id, o) {
    const box = typeof id === "string" ? document.getElementById(id) : id;
    box.classList.add("ml-map");
    const ml = new maplibregl.Map({
      container: box, style: EMPTY_STYLE, center: lngLat(o.center), zoom: o.zoom - ZOFF,
      maxZoom: 20 - ZOFF, attributionControl: false,
      // Giro con dos dedos o con el botón derecho (fase 6); sin inclinación de momento.
      dragRotate: true, pitchWithRotate: false, touchPitch: false, maxPitch: 0, keyboard: false,
    });
    if (o.zoomControl) ml.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    // Lo que toca el estilo (fuentes, capas) espera a que esté cargado: al principio y mientras se
    // cambia de fondo, MapLibre no deja añadir nada.
    // Ojo: isStyleLoaded() también espera a las teselas (puede tardar mucho o no llegar si fallan);
    // aquí basta con que esté cargada la descripción del estilo.
    const pending = [];
    const run = (f) => { try { f(); } catch (e) { console.error(e); } };
    const styleReady = () => !!(ml.style && ml.style._loaded);
    const flushPending = () => { if (styleReady()) pending.splice(0).forEach(run); };
    ml.on("load", flushPending);
    ml.on("style.load", flushPending);
    ml.on("styledata", flushPending);
    const ready = (f) => { if (styleReady()) run(f); else pending.push(f); };

    // Atribución: la del fondo (de su estilo) más la nuestra.
    const attrs = [];
    let attrCtl = null;
    function setAttrControl() {
      if (attrCtl) ml.removeControl(attrCtl);
      attrCtl = new maplibregl.AttributionControl({ compact: false, customAttribution: attrs.slice() });
      ml.addControl(attrCtl, "bottom-right");
    }
    setAttrControl();

    // Eventos con la forma de los de Leaflet (latlng, containerPoint, originalEvent).
    const MOUSE = new Set(["click", "contextmenu", "mousemove", "dblclick"]);
    const wrap = (ev, fn) => (MOUSE.has(ev)
      ? (e) => fn({ latlng: { lat: e.lngLat.lat, lng: e.lngLat.lng }, containerPoint: { x: e.point.x, y: e.point.y }, originalEvent: e.originalEvent })
      : () => fn({}));
    const on = (evs, fn, once) => evs.split(/\s+/).filter(Boolean).forEach((ev) => (once ? ml.once(ev, wrap(ev, fn)) : ml.on(ev, wrap(ev, fn))));

    // ----- Trazos y círculos: una fuente GeoJSON por grupo y capas por tipo -----
    // Orden: los grupos por z (y, a igual z, por orden de creación); dentro de cada grupo, líneas
    // continuas, después las discontinuas y encima los círculos (como los dibuja Leaflet).
    const groups = [];
    const anchors = [];   // otras capas nuestras con su z (las paradas, 600), para ordenar los grupos
    let gseq = 0;
    const layerOrder = (g) => g.layers;   // ids de capas del grupo, en orden de dibujo
    function beforeIdFor(g, kind) {
      if (kind !== "C") { const c = g.layers.find((x) => x.endsWith(":C")); if (c) return c; }
      const later = groups.concat(anchors).filter((h) => h !== g && (h.z > g.z || (h.z === g.z && h.seq > g.seq)) && h.layers.length)
        .sort((a, b) => a.z - b.z || a.seq - b.seq);
      return later.length ? layerOrder(later[0])[0] : undefined;
    }
    function ensureLayer(g, key) {
      const lid = `${g.src}:${key}`;
      if (g.layers.includes(lid)) return;
      let layer;
      if (key === "C") {
        layer = { id: lid, type: "circle", source: g.src, filter: ["==", ["get", "k"], key], paint: {
          "circle-radius": ["get", "r"], "circle-color": ["get", "f"], "circle-opacity": ["get", "fo"],
          "circle-stroke-width": ["get", "sw"], "circle-stroke-color": ["get", "sc"], "circle-stroke-opacity": ["get", "so"],
        } };
      } else {
        layer = { id: lid, type: "line", source: g.src, filter: ["==", ["get", "k"], key],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ["get", "c"], "line-width": ["get", "w"], "line-opacity": ["get", "o"] } };
        if (key.startsWith("D")) layer.paint["line-dasharray"] = key.slice(2).split("|")[0].split(",").map(Number);
      }
      const before = beforeIdFor(g, key[0]);
      ml.addLayer(layer, before && ml.getLayer(before) ? before : undefined);
      // dentro del grupo: líneas, discontinuas, círculos
      g.layers.push(lid);
      g.layers.sort((a, b) => "LDC".indexOf(a.split(":").pop()[0]) - "LDC".indexOf(b.split(":").pop()[0]));
    }
    function flush(g) {
      g.dirty = false;
      const feats = [];
      for (const it of g.items) if (it.on) feats.push(it.f);
      const src = ml.getSource(g.src);
      if (src) src.setData({ type: "FeatureCollection", features: feats });
    }
    const touch = (g) => { if (!g.dirty) { g.dirty = true; requestAnimationFrame(() => ready(() => flush(g))); } };
    const lineFeature = (pts, st) => {
      const w = st.weight != null ? st.weight : 3;
      let key = "L";
      if (st.dashArray) {
        // Leaflet da el discontinuo en píxeles; MapLibre, en múltiplos del grosor.
        const d = String(st.dashArray).split(/[ ,]+/).map(Number).map((v) => +(v / w).toFixed(3));
        key = `D:${d.join(",")}|${w}`;
      }
      return { key, f: { type: "Feature", properties: { k: key, c: st.color || "#3388ff", w, o: st.opacity != null ? st.opacity : 1 },
        geometry: { type: "LineString", coordinates: pts.map(lngLat) } } };
    };
    const circleFeature = (ll, st) => {
      const r = st.radius != null ? st.radius : 10, sw = st.stroke === false ? 0 : (st.weight != null ? st.weight : 3);
      const color = st.color || "#3388ff";
      return { type: "Feature", properties: { k: "C", r: Math.max(0, r - sw / 2), sw, sc: color, so: st.opacity != null ? st.opacity : 1,
        f: st.fillColor || color, fo: st.fill === false ? 0 : (st.fillOpacity != null ? st.fillOpacity : 0.2) },
        geometry: { type: "Point", coordinates: lngLat(ll) } };
    };
    function makeGroup(z) {
      const g = { seq: gseq++, z: z || 400, src: `${PV}g${gseq}`, layers: [], items: [], dirty: false };
      groups.push(g);
      ready(() => { if (!ml.getSource(g.src)) ml.addSource(g.src, { type: "geojson", data: { type: "FeatureCollection", features: [] } }); });
      const own = (it) => ({
        remove() { it.on = false; g.items.splice(g.items.indexOf(it), 1); touch(g); return this; },
        setLatLngs(pts) { it.f.geometry.coordinates = pts.map(lngLat); touch(g); return this; },
        setLatLng(ll) { it.f.geometry.coordinates = lngLat(ll); touch(g); return this; },
        setRadius(r) { const sw = it.f.properties.sw; it.f.properties.r = Math.max(0, r - sw / 2); touch(g); return this; },
        show() { if (!it.on) { it.on = true; if (!g.items.includes(it)) g.items.push(it); touch(g); } return this; },
      });
      const add = (key, f, on = true) => {
        const it = { f, on };
        if (on) g.items.push(it);
        ready(() => ensureLayer(g, key));
        touch(g);
        return own(it);
      };
      return {
        g,
        line: (pts, st) => { const { key, f } = lineFeature(pts, st || {}); return add(key, f); },
        circle: (ll, st) => add("C", circleFeature(ll, st || {})),
        hiddenCircle: (ll, st) => add("C", circleFeature(ll, st || {}), false),
        clear() { g.items.forEach((it) => { it.on = false; }); g.items = []; touch(g); return this; },
      };
    }
    // Con el estilo nuevo, los datos de cada grupo se vuelven a poner (los del cambio pueden ser viejos).
    ml.on("style.load", () => groups.forEach(touch));
    let looseGroup = null;   // círculos sueltos (el anillo de la parada elegida), encima de todo
    const loose = () => looseGroup || (looseGroup = makeGroup(500));

    // ----- Paradas: una sola capa de símbolos (fase 2) -----
    // Icono de parada (señal con un autobús) dibujado en un lienzo con las mismas formas que el SVG
    // de app.js, a 2× y con la sombra dentro; uno por pareja de colores ("fondo|figura"). MapLibre
    // lo pide cuando le falta (también tras cambiar de fondo, que borra las imágenes).
    const STOP_IMG = "pv-stop:";
    function stopImage(bg, fg) {
      const k = 2, W = 38 * k, c = document.createElement("canvas");
      c.width = c.height = W;
      const x = c.getContext("2d");
      x.scale(k, k);
      x.translate(3, 3);
      const rr = (X, Y, w, h, r) => { x.beginPath(); x.roundRect(X, Y, w, h, r); };
      x.save();
      x.shadowColor = "rgba(19,34,44,.45)"; x.shadowBlur = 2 * k * 0.8; x.shadowOffsetY = 1;
      rr(1.5, 1.5, 29, 29, 8); x.fillStyle = bg; x.fill();
      x.restore();
      rr(1.5, 1.5, 29, 29, 8); x.lineWidth = 2.5; x.strokeStyle = "#fff"; x.stroke();
      x.fillStyle = fg;
      x.beginPath(); x.arc(8.6, 9.6, 2.6, 0, 2 * Math.PI); x.fill();
      rr(7.8, 11.5, 1.6, 14.5, 0.8); x.fill();
      rr(13, 9.5, 12.5, 13.5, 2.6); x.fill();
      rr(14.4, 22, 2.6, 3.6, 0.9); x.fill();
      rr(21.5, 22, 2.6, 3.6, 0.9); x.fill();
      x.fillStyle = bg; rr(15, 11.5, 8.5, 5.6, 1.2); x.fill();
      return { width: W, height: W, data: new Uint8Array(x.getImageData(0, 0, W, W).data.buffer) };
    }
    ml.on("styleimagemissing", (e) => {
      if (!e.id || !e.id.startsWith(STOP_IMG) || ml.hasImage(e.id)) return;
      const [bg, fg] = e.id.slice(STOP_IMG.length).split("|");
      ml.addImage(e.id, stopImage(bg, fg), { pixelRatio: 2 });
    });
    // Tamaño como en app.js (sizeFor, en la escala de Leaflet): 12 px hasta el 12, 16, 20, 26 y 30
    // desde el 16; las de la línea abierta, 4 px más. La imagen (38 px) es el icono de 32 + márgenes.
    const sizeAt = (n) => ["/", ["+", n, ["*", ["get", "big"], 4]], 32];
    const STOP_SIZE = ["step", ["zoom"], sizeAt(12), 13 - ZOFF, sizeAt(16), 14 - ZOFF, sizeAt(20), 15 - ZOFF, sizeAt(26), 16 - ZOFF, sizeAt(30)];
    function stopLayer(o2) {
      const SRC = `${PV}stops`, LID = `${PV}stops`;
      const anchor = { z: 600, seq: 1e9, layers: [] };
      anchors.push(anchor);
      let list = [], look = null, hidden = false;
      const byId = new Map();
      const data = () => ({ type: "FeatureCollection", features: list.map((st) => {
        const l = look(st);
        return { type: "Feature", properties: { id: st.id, img: `${STOP_IMG}${l.bg}|${l.fg}`, big: l.big ? 1 : 0, op: l.op, sort: l.sort || 0 },
          geometry: { type: "Point", coordinates: [st.ll[1], st.ll[0]] } };
      }) });
      const push = () => ready(() => { const src = ml.getSource(SRC); if (src && look) src.setData(data()); });
      ready(() => {
        if (!ml.getSource(SRC)) ml.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        if (!ml.getLayer(LID)) {
          // encima de los trazos (como el panel de marcadores de Leaflet), debajo de los marcadores
          const later = groups.filter((h) => h.z > 600 && h.layers.length).sort((a, b2) => a.z - b2.z || a.seq - b2.seq);
          ml.addLayer({ id: LID, type: "symbol", source: SRC,
            layout: { "icon-image": ["get", "img"], "icon-size": STOP_SIZE, "icon-allow-overlap": true, "icon-ignore-placement": true,
              "symbol-sort-key": ["get", "sort"], visibility: hidden ? "none" : "visible" },
            paint: { "icon-opacity": ["get", "op"] } }, later.length ? later[0].layers[0] : undefined);
          anchor.layers = [LID];
        }
        if (look) push();
      });
      ml.on("style.load", push);
      // Tocar: la de encima. Marca el toque para que no lo atiendan también los demás manejadores.
      ml.on("click", LID, (e) => {
        if (hidden || !e.features || !e.features.length) return;
        const st = byId.get(e.features[0].properties.id);
        if (!st) return;
        if (e.originalEvent) e.originalEvent._stopHit = true;
        o2.onClick(st);
      });
      if (o2.hover) {
        ml.on("mousemove", LID, (e) => {
          const st = !hidden && e.features && e.features.length && byId.get(e.features[0].properties.id);
          ml.getCanvas().style.cursor = st ? "pointer" : "";
          box.title = st && o2.title ? o2.title(st) : "";
        });
        ml.on("mouseleave", LID, () => { ml.getCanvas().style.cursor = ""; box.title = ""; });
      }
      return {
        set(items, fn) { list = items; look = fn; byId.clear(); items.forEach((st) => byId.set(st.id, st)); push(); return this; },
        update() { push(); return this; },
        hide(h) {
          if (h === hidden) return this;
          hidden = h;
          ready(() => { if (ml.getLayer(LID)) ml.setLayoutProperty(LID, "visibility", h ? "none" : "visible"); });
          return this;
        },
      };
    }

    // Capas fijas (no de grupos) con su z, para ordenarlas como los paneles de Leaflet.
    function addFixedLayer(layer, z) {
      const later = groups.concat(anchors).filter((h) => h.z > z && h.layers.length).sort((a2, b2) => a2.z - b2.z || a2.seq - b2.seq);
      const before = later.length ? later[0].layers[0] : undefined;
      ml.addLayer(layer, before && ml.getLayer(before) ? before : undefined);
    }
    const setVis = (ids, on) => ready(() => ids.forEach((id) => { if (ml.getLayer(id)) ml.setLayoutProperty(id, "visibility", on ? "visible" : "none"); }));

    // Vigo Vertical: flecha (sube hacia el extremo de arriba) y ascensor, como en el lienzo de antes.
    const VV_INK = "rgba(91,79,69,.78)", VV_HALO = "rgba(255,255,255,.85)";
    function vvImage(kind) {
      const k = 2, S = 20, c = document.createElement("canvas"), x = c.getContext("2d");
      c.width = c.height = S * k;
      x.scale(k, k);
      const m = S / 2;
      if (kind === "arrow") {
        const h = 7;   // lw (4) + 3, como antes; apunta hacia arriba (norte de la imagen)
        x.fillStyle = VV_INK; x.strokeStyle = VV_HALO; x.lineWidth = 1.5; x.lineJoin = "round";
        x.beginPath(); x.moveTo(m, m - h); x.lineTo(m + h, m + h * 0.6); x.lineTo(m - h, m + h * 0.6); x.closePath(); x.stroke(); x.fill();
      } else {
        const sz = 14, box = (x0, y0, w, r) => { x.beginPath(); if (x.roundRect) x.roundRect(x0, y0, w, w, r); else x.rect(x0, y0, w, w); x.fill(); };
        x.fillStyle = VV_HALO; box(m - sz / 2 - 1.5, m - sz / 2 - 1.5, sz + 3, 4);
        x.fillStyle = VV_INK; box(m - sz / 2, m - sz / 2, sz, 3);
        x.fillStyle = "#fff";
        const a = sz * 0.22;
        x.beginPath(); x.moveTo(m, m - sz * 0.36); x.lineTo(m + a, m - sz * 0.06); x.lineTo(m - a, m - sz * 0.06); x.fill();
        x.beginPath(); x.moveTo(m, m + sz * 0.36); x.lineTo(m + a, m + sz * 0.06); x.lineTo(m - a, m + sz * 0.06); x.fill();
      }
      return { width: c.width, height: c.height, data: new Uint8Array(x.getImageData(0, 0, c.width, c.height).data.buffer) };
    }
    ml.on("styleimagemissing", (e) => {
      if ((e.id === "pv-vv-arrow" || e.id === "pv-vv-lift") && !ml.hasImage(e.id)) ml.addImage(e.id, vvImage(e.id === "pv-vv-arrow" ? "arrow" : "lift"), { pixelRatio: 2 });
    });
    // ----- Vigo Vertical (fase 6): rampas, escaleras mecánicas y ascensores como capas -----
    // Trazo con halo; peldaños como un trazo ancho a rayas finas; flecha hacia el extremo de arriba
    // (gira con el mapa); ascensor: cuadradito con flechas (el inclinado, en mitad de su trazo).
    function verticalLayer(o2) {
      const SRC = `${PV}vv`, PTS = `${PV}vv-pts`, ids = [`${PV}vv-halo`, `${PV}vv-ink`, `${PV}vv-steps`, `${PV}vv-arrow`, `${PV}vv-lift`];
      const anchor = { z: 449, seq: 1e9 + 2, layers: [] };
      anchors.push(anchor);
      let lines = null, pts = null, shown = false;
      const minzoom = o2.minZoom - ZOFF, LW = ["step", ["zoom"], 3, 18 - ZOFF, 4];
      const build = () => ready(() => {
        if (!lines) return;
        if (!ml.getSource(SRC)) ml.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: lines } });
        if (!ml.getSource(PTS)) ml.addSource(PTS, { type: "geojson", data: { type: "FeatureCollection", features: pts } });
        const vis = shown ? "visible" : "none", lay = { "line-cap": "round", "line-join": "round", visibility: vis };
        const add = (l) => { if (!ml.getLayer(l.id)) addFixedLayer({ minzoom, ...l }, 449); };
        add({ id: ids[0], type: "line", source: SRC, layout: lay, paint: { "line-color": VV_HALO, "line-width": ["step", ["zoom"], 6, 18 - ZOFF, 7] } });
        add({ id: ids[1], type: "line", source: SRC, layout: lay, paint: { "line-color": VV_INK, "line-width": LW } });
        add({ id: ids[2], type: "line", source: SRC, filter: ["==", ["get", "t"], "escalera"], layout: { "line-join": "round", visibility: vis },
          paint: { "line-color": VV_INK, "line-width": ["step", ["zoom"], 10, 18 - ZOFF, 12], "line-dasharray": [0.15, 0.35] } });
        add({ id: ids[3], type: "symbol", source: PTS, filter: ["==", ["get", "k"], "arrow"],
          layout: { "icon-image": "pv-vv-arrow", "icon-rotate": ["get", "rot"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true,
            "icon-size": ["step", ["zoom"], 6 / 7, 18 - ZOFF, 1], visibility: vis } });
        add({ id: ids[4], type: "symbol", source: PTS, filter: ["==", ["get", "k"], "lift"],
          layout: { "icon-image": "pv-vv-lift", "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-size": ["step", ["zoom"], 12 / 14, 18 - ZOFF, 1], visibility: vis } });
        anchor.layers = [ids[0]];
      });
      ml.on("style.load", () => { if (lines) { const a = ml.getSource(SRC); if (a) a.setData({ type: "FeatureCollection", features: lines }); const b2 = ml.getSource(PTS); if (b2) b2.setData({ type: "FeatureCollection", features: pts }); } });
      return {
        loaded: () => !!lines,
        set(els) {
          lines = []; pts = [];
          for (const el of els) {
            const a = [el.ka[1], el.ka[0]], b2 = [el.kb[1], el.kb[0]];
            if (el.t === "ascensor") { pts.push({ type: "Feature", properties: { k: "lift" }, geometry: { type: "Point", coordinates: a } }); continue; }
            lines.push({ type: "Feature", properties: { t: el.t }, geometry: { type: "LineString", coordinates: [a, b2] } });
            const mid = [(a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2];
            if (el.t === "inclinado") { pts.push({ type: "Feature", properties: { k: "lift" }, geometry: { type: "Point", coordinates: mid } }); continue; }
            // Rumbo de a a b (grados desde el norte, en el sentido de las agujas), en Mercator.
            const dx = (b2[0] - a[0]) * Math.cos(mid[1] * Math.PI / 180), dy = b2[1] - a[1];
            const len = Math.hypot(dx, dy) * 111320;
            if (len < 9) continue;   // muy corto: sin flecha (antes, menos de 10 px)
            pts.push({ type: "Feature", properties: { k: "arrow", rot: Math.atan2(dx, dy) * 180 / Math.PI }, geometry: { type: "Point", coordinates: mid } });
          }
          build();
          return this;
        },
        show(on) { if (on !== shown) { shown = on; setVis(ids, on); } return this; },
      };
    }

    // ----- Estilo nuevo (fase 7): retoques del fondo, relieve, red de líneas y sitios -----
    // Puntos de la propuesta (artefacto "Estilo del mapa de Vigo Bus"), elegidos todos por el
    // usuario el 9/11: 1 sitios útiles y avenidas legibles, 2 relieve, 3 ayudas para andar, 4 la red
    // de líneas al alejar, 5 colores de Vigo Bus (el rojo, solo para lo nuestro).
    // Capas del fondo de OpenFreeMap (positron, dark): ver github.com/openfreemap/openfreemap-styles.
    const OMT = "openmaptiles";
    function tuneBase(st) {
      if (!st || !Array.isArray(st.layers)) return st;
      const light = st.layers.some((l) => l.id === "highway-name-major");
      const dark = !light && st.layers.some((l) => l.id === "highway_name_other");
      if (!light && !dark) return st;
      const L = (id) => st.layers.find((l) => l.id === id);
      const paint = (id, k, v) => { const l = L(id); if (l) l.paint = { ...(l.paint || {}), [k]: v }; };
      const lay = (id, k, v) => { const l = L(id); if (l) l.layout = { ...(l.layout || {}), [k]: v }; };
      // Fuera lo que no sirve para ir en bus: límites administrativos y escudos de carretera.
      ["boundary_3", "boundary_2", "boundary_disputed", "boundary_state", "boundary_country_z0-4", "boundary_country_z5-",
        "highway-shield-non-us", "highway-shield-us-interstate", "road_shield_us"].forEach((id) => lay(id, "visibility", "none"));
      if (light) {
        // 5. Colores: tierra cálida, ría azul suave, parques verde apagado, edificios tostados.
        paint("background", "background-color", "#f4f2ee");
        paint("water", "fill-color", "#bed6e4");
        paint("waterway", "line-color", "#bed6e4");
        paint("park", "fill-color", "#dfe8d6");
        paint("landcover_wood", "fill-color", "#dce6d2");
        paint("landuse_residential", "fill-color", "#efebe5");
        paint("building", "fill-color", "#e8e2da");
        paint("building", "fill-outline-color", "#d9d1c6");
        paint("highway_minor", "line-color", "#fdfcfa");
        paint("highway_major_casing", "line-color", "#dcd4c8");
        // 1. Nombres de las avenidas más oscuros y algo más grandes; los de las calles, discretos.
        paint("highway-name-major", "text-color", "#4a433c");
        lay("highway-name-major", "text-size", ["interpolate", ["linear"], ["zoom"], 13, 12, 16, 14]);
        paint("highway-name-minor", "text-color", "#7f766c");
        // 3. Ayudas para andar: calles peatonales en arena, escaleras con peldaños y sendas a puntos.
        const i = st.layers.findIndex((l) => l.id === "highway_path");
        if (i >= 0) {
          lay("highway_path", "visibility", "none");
          const path = (sub) => ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "class"], "path"], sub];
          const isSub = (v) => ["match", ["get", "subclass"], v, true, false];
          const W = (...a) => ["interpolate", ["exponential", 1.3], ["zoom"], ...a];
          const round = { "line-cap": "round", "line-join": "round" };
          st.layers.splice(i + 1, 0,
            { id: "vb-peatonal-borde", type: "line", source: OMT, "source-layer": "transportation", minzoom: 14, filter: path(isSub(["pedestrian"])), layout: round,
              paint: { "line-color": "#dccbad", "line-width": W(14, 2, 18, 13, 20, 24) } },
            { id: "vb-peatonal", type: "line", source: OMT, "source-layer": "transportation", minzoom: 14, filter: path(isSub(["pedestrian"])), layout: round,
              paint: { "line-color": "#f3e8d5", "line-width": W(14, 1, 18, 10, 20, 20) } },
            { id: "vb-escalera", type: "line", source: OMT, "source-layer": "transportation", minzoom: 15, filter: path(isSub(["steps"])), layout: round,
              paint: { "line-color": "#eadcc5", "line-width": W(15, 2, 18, 6, 20, 10) } },
            { id: "vb-peldanos", type: "line", source: OMT, "source-layer": "transportation", minzoom: 15, filter: path(isSub(["steps"])),
              paint: { "line-color": "#8c6e50", "line-width": W(15, 4, 18, 8, 20, 12), "line-dasharray": [0.16, 0.32] } },
            { id: "vb-senda", type: "line", source: OMT, "source-layer": "transportation", minzoom: 15.5,
              filter: path(["!", isSub(["pedestrian", "steps"])]), layout: { "line-join": "round" },
              paint: { "line-color": "#a5927a", "line-width": W(15.5, 1, 18, 1.6, 20, 2.4), "line-dasharray": [2, 1.6] } });
        }
      }
      return st;
    }
    // Capas nuestras de posición fija (se vuelven a colocar al cambiar de fondo).
    const FIXED = new Set([`${PV}relieve`, `${PV}red`, `${PV}sitios`, `${PV}sitios2`]);
    const DEM_URL = new URL("data/relieve/teselas/", location.href).href + "{z}/{x}/{y}.png";
    let redOn = false, redData = null, sitesData = null;
    function placeFixed() {
      if (!styleReady()) return;
      const layers = ml.getStyle().layers;
      const firstBaseSymbol = (layers.find((l) => l.type === "symbol" && !l.id.startsWith(PV)) || {}).id;
      const firstOurs = (layers.find((l) => l.id.startsWith(PV) && !FIXED.has(l.id)) || {}).id;
      const vectorBase = layers.some((l) => l.id === "building");
      // 2. Relieve (MDT del IGN, tools/teselas_relieve.py), debajo de los edificios; no en satélite.
      if (vectorBase) {
        if (!ml.getSource(`${PV}dem`)) ml.addSource(`${PV}dem`, { type: "raster-dem", tiles: [DEM_URL], tileSize: 256, maxzoom: 14, encoding: "terrarium",
          bounds: [-8.845, 42.105, -8.585, 42.3] });   // la atribución del IGN ya la pone app.js
        if (!ml.getLayer(`${PV}relieve`)) {
          const dark = base === "dark";
          ml.addLayer({ id: `${PV}relieve`, type: "hillshade", source: `${PV}dem`, paint: {
            "hillshade-exaggeration": dark ? 0.3 : 0.38, "hillshade-shadow-color": dark ? "#000000" : "#4f453d",
            "hillshade-highlight-color": dark ? "#3c4554" : "#fffdf8", "hillshade-accent-color": dark ? "#111111" : "#6f6358" } }, "building");
        }
      }
      // 4. Red de líneas, debajo de los nombres de las calles; se desvanece al acercarse.
      if (redData) {
        if (!ml.getSource(`${PV}red`)) ml.addSource(`${PV}red`, { type: "geojson", data: redData });
        if (!ml.getLayer(`${PV}red`)) ml.addLayer({ id: `${PV}red`, type: "line", source: `${PV}red`, maxzoom: 16 - ZOFF + 0.6,
          layout: { "line-cap": "round", "line-join": "round", visibility: redOn ? "visible" : "none" },
          paint: { "line-color": ["get", "c"], "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1, 13, 1.6, 15, 2.6],
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.85, 14, 0.7, 15.5, 0] } },
        firstBaseSymbol && ml.getLayer(firstBaseSymbol) ? firstBaseSymbol : firstOurs);
      }
      // 1. Sitios útiles: icono y nombre, encima de los nombres del fondo y debajo de lo nuestro.
      if (sitesData) {
        if (!ml.getSource(`${PV}sitios`)) ml.addSource(`${PV}sitios`, { type: "geojson", data: sitesData });
        // Los grandes (hospital, estación, aeropuerto, puerto) desde más lejos; los demás, de cerca
        // (con todos a la vez, a media distancia se tapaban con las paradas).
        [[`${PV}sitios`, 12.5, ["<=", ["get", "o"], 3]], [`${PV}sitios2`, 14.6, [">", ["get", "o"], 3]]].forEach(([id, minzoom, filter]) => {
        if (!ml.getLayer(id)) {
          const onDark = base !== "light";
          ml.addLayer({ id, type: "symbol", source: `${PV}sitios`, minzoom, filter,
            layout: { "icon-image": ["concat", "pv-sitio:", ["get", "t"]], "icon-size": ["interpolate", ["linear"], ["zoom"], 12.5, 0.8, 15, 1],
              "icon-allow-overlap": true, "symbol-sort-key": ["get", "o"],
              "text-field": ["get", "n"], "text-font": ["Noto Sans Bold"], "text-size": 11.5, "text-anchor": "left", "text-offset": [0.9, 0],
              "text-optional": true, "text-max-width": 9 },
            paint: { "text-color": onDark ? "#ffffff" : "#2e2924", "text-halo-color": onDark ? "rgba(0,0,0,.75)" : "rgba(255,255,255,.9)", "text-halo-width": 1.4 } },
          firstOurs && ml.getLayer(firstOurs) ? firstOurs : undefined);
        }
        });
      }
    }
    // Iconos de los sitios: círculo de color con una letra (como en la maqueta).
    const SITE_LOOK = { hospital: ["#c8463d", "H"], estacion: ["#46465a", "T"], aeropuerto: ["#46465a", "A"], puerto: ["#286ea0", "B"],
      universidad: ["#5a6e8c", "U"], comercio: ["#966e46", "C"], mercado: ["#966e46", "M"], museo: ["#785a96", "M"], playa: ["#d6a028", "P"], deporte: ["#3c8250", "E"] };
    ml.on("styleimagemissing", (e) => {
      if (!e.id || !e.id.startsWith("pv-sitio:") || ml.hasImage(e.id)) return;
      const [col, ch] = SITE_LOOK[e.id.slice(9)] || ["#666", "·"];
      const k = 2, S = 18, c = document.createElement("canvas"), x = c.getContext("2d");
      c.width = c.height = S * k; x.scale(k, k);
      x.fillStyle = "#fff"; x.beginPath(); x.arc(S / 2, S / 2, 8.5, 0, 2 * Math.PI); x.fill();
      x.fillStyle = col; x.beginPath(); x.arc(S / 2, S / 2, 7, 0, 2 * Math.PI); x.fill();
      x.fillStyle = "#fff"; x.font = "700 9.5px Barlow, system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
      x.fillText(ch, S / 2, S / 2 + 0.5);
      ml.addImage(e.id, { width: S * k, height: S * k, data: new Uint8Array(x.getImageData(0, 0, S * k, S * k).data.buffer) }, { pixelRatio: k });
    });
    // lines: [{ pts: [[lat, lon], …], color }]
    function setNetwork(lines) {
      redData = { type: "FeatureCollection", features: lines.map((l) => ({ type: "Feature", properties: { c: l.color }, geometry: { type: "LineString", coordinates: l.pts.map(lngLat) } })) };
      ready(() => { const src = ml.getSource(`${PV}red`); if (src) src.setData(redData); placeFixed(); });
    }
    function showNetwork(on) {
      if (on === redOn) return;
      redOn = on;
      ready(() => { if (ml.getLayer(`${PV}red`)) ml.setLayoutProperty(`${PV}red`, "visibility", on ? "visible" : "none"); });
    }
    // sites: [{ ll, name, type, order }] (order: menor = más importante)
    function setSites(sites) {
      sitesData = { type: "FeatureCollection", features: sites.map((s) => ({ type: "Feature", properties: { n: s.name, t: s.type, o: s.order }, geometry: { type: "Point", coordinates: lngLat(s.ll) } })) };
      ready(() => { const src = ml.getSource(`${PV}sitios`); if (src) src.setData(sitesData); placeFixed(); });
    }
    ready(placeFixed);

    // ----- Marcadores (elementos de la página, como los de Leaflet) -----
    function iconEl(d) {
      let el;
      if (d.html != null) {
        el = document.createElement("div");
        el.className = `pv-icon ${d.className || ""}`.trim();
        el.innerHTML = d.html;
      } else {
        el = document.createElement("img");
        el.src = d.url; el.alt = "";
        el.className = `pv-icon ${d.className || ""}`.trim();
        el.draggable = false;
      }
      if (d.size) { el.style.width = `${d.size[0]}px`; el.style.height = `${d.size[1]}px`; }
      return el;
    }
    function marker(ll, o2) {
      const outer = document.createElement("div");
      outer.className = "pv-marker";
      let inner = iconEl(o2.icon), cur = o2.icon;
      outer.appendChild(inner);
      if (o2.interactive === false) outer.style.pointerEvents = "none";
      // El nombre, como Leaflet: en el alt de la imagen (lectores de pantalla).
      const setAlt = (el) => { if (o2.alt) { if (el.tagName === "IMG") el.alt = o2.alt; else el.setAttribute("aria-label", o2.alt); } };
      setAlt(inner);
      const anchorOf = (d) => (d.anchor || (d.size ? [d.size[0] / 2, d.size[1] / 2] : [0, 0]));
      const mk = new maplibregl.Marker({ element: outer, anchor: "top-left", draggable: !!o2.draggable });
      // Arrastre soltado fuera del mapa (en el ordenador, encima del panel): MapLibre solo ve el
      // ratón sobre el mapa y el arrastre no terminaba; se le pasa el "soltar" para que acabe ahí.
      if (o2.draggable) {
        let dragging = false;
        mk.on("dragstart", () => {
          dragging = true;
          const up = (e) => {
            window.removeEventListener("mouseup", up, true);
            if (!dragging || box.contains(e.target)) return;
            ml.getCanvasContainer().dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, button: 0 }));
          };
          window.addEventListener("mouseup", up, true);
        });
        mk.on("dragend", () => { dragging = false; });
      }
      const setAnchor = (d) => { const a = anchorOf(d); mk.setOffset([-a[0], -a[1]]); };
      setAnchor(cur);
      mk.setLngLat(lngLat(ll));
      // Encima de los lienzos propios (z 1–2), como en Leaflet (panel de marcadores 600).
      // Como Leaflet: por clase (zIndexOffset) y, dentro de cada una, el más al sur encima.
      const off = o2.zIndexOffset || 0;
      let extra = 0, lat = toLL(ll).lat;
      const setZ = () => { outer.style.zIndex = String(10 + (off + extra) * 100 + Math.max(0, Math.round((42.6 - lat) * 1e4))); };
      setZ();
      let shown = false, clicks = [];
      return {
        setLatLng(p) { mk.setLngLat(lngLat(p)); const la = toLL(p).lat; if (la !== lat) { lat = la; setZ(); } return this; },
        getLatLng() { const p = mk.getLngLat(); return { lat: p.lat, lng: p.lng }; },
        show() { if (!shown) { mk.addTo(ml); shown = true; } return this; },
        remove() { if (shown) { mk.remove(); shown = false; } return this; },
        visible: () => shown,
        getElement: () => inner,
        setIcon(d) {
          if (d === cur || (d.key && cur.key === d.key)) return this;
          const n = iconEl(d);
          n.style.opacity = inner.style.opacity;
          setAlt(n);
          outer.replaceChild(n, inner);
          inner = n; cur = d;
          setAnchor(d);
          return this;
        },
        setOpacity(op) { inner.style.opacity = op === 1 ? "" : String(op); return this; },
        setZIndexOffset(z) { extra = z; setZ(); return this; },
        on(ev, fn) {
          if (ev === "dragend") mk.on("dragend", () => { const p = mk.getLngLat(); fn({ latlng: { lat: p.lat, lng: p.lng } }); });
          else if (ev === "click") { outer.addEventListener("click", (e) => { e.stopPropagation(); fn(e); }); clicks.push(fn); }
          return this;
        },
        tooltip(fn) { outer.addEventListener("mouseenter", () => { outer.title = String(fn()).replace(/<[^>]*>/g, "").replace(/&amp;/g, "&"); }); return this; },
      };
    }

    // ----- Fondo -----
    let base = "light", vectorOk = false, styleSeq = 0;
    // Al cambiar de estilo se conservan nuestras fuentes y capas (todo lo que empieza por "pv-").
    function setStyle(style) {
      const seq = ++styleSeq;
      ml.setStyle(style, {
        transformStyle: (prev, next) => {
          next = tuneBase(next);
          if (!prev) return next;
          const srcs = Object.fromEntries(Object.entries(prev.sources || {}).filter(([k]) => k.startsWith(PV)));
          // Las capas de posición fija (relieve, red, sitios) se vuelven a poner en su sitio con el
          // estilo nuevo (placeFixed); las demás nuestras van encima, como estaban.
          const lays = (prev.layers || []).filter((l) => l.id.startsWith(PV) && !FIXED.has(l.id));
          return { ...next, sources: { ...next.sources, ...srcs }, layers: [...next.layers, ...lays] };
        },
      });
      return seq;
    }
    function useOSM() { vectorOk = false; box.classList.remove("gl-base"); if (base !== "sat") setStyle(OSM_STYLE); }
    function vector(kind) {
      const seq = setStyle(OFM(kind === "dark" ? "dark" : "positron"));
      let fiord = false, done = false;
      const timer = setTimeout(() => { if (!done && seq === styleSeq) useOSM(); }, BASE_TIMEOUT);
      const ok = () => { if (seq !== styleSeq) return; done = true; vectorOk = true; clearTimeout(timer); box.classList.add("gl-base"); };
      ml.once("style.load", ok);
      const onErr = (e) => {
        if (done || seq !== styleSeq) { ml.off("error", onErr); return; }
        if (e && e.sourceId) return;   // tesela suelta: no cambia nada
        if (kind === "dark" && !fiord) { fiord = true; setStyle(OFM("fiord")); ml.once("style.load", ok); return; }
        clearTimeout(timer); ml.off("error", onErr); useOSM();
      };
      ml.on("error", onErr);
    }
    function setBase(kind) {
      base = kind;
      box.classList.toggle("sat-base", kind === "sat");
      box.classList.toggle("dark-base", kind === "dark");
      if (kind === "sat") { setStyle(SAT_STYLE); return; }
      vector(kind);
    }
    ml.on("style.load", () => placeFixed());
    function startBase(kind) { ready(() => setBase(kind)); }
    function waterAt(ll) {
      if (!vectorOk || base === "sat") return null;
      try {
        const top = ml.queryRenderedFeatures(ml.project(lngLat(ll))).find((f) => f.layer && f.layer.type === "fill" && !f.layer.id.startsWith(PV));
        return !!top && top.sourceLayer === "water";
      } catch { return null; }
    }

    // ----- Lienzos propios encima del mapa (números de portal, paradas lejanas) -----
    // Se dibujan en coordenadas de pantalla al soltar el mapa (como en Leaflet); mientras se
    // arrastra, se desplazan con él.
    const panes = [];
    function canvasPane(name, z, cls) {
      const holder = document.createElement("div");
      holder.className = `pv-pane pv-pane-${name}`;
      Object.assign(holder.style, { position: "absolute", inset: "0", overflow: "hidden", pointerEvents: "none", zIndex: String(z >= 500 ? 2 : 1) });
      ml.getCanvasContainer().appendChild(holder);
      const canvas = document.createElement("canvas");
      canvas.className = cls || "";
      canvas.style.position = "absolute";
      holder.appendChild(canvas);
      const pane = { canvas, ref: null, z: 0, x: 0, y: 0 };
      panes.push(pane);
      pane.place = (mx, my) => {
        pane.x = -mx; pane.y = -my;
        canvas.style.left = `${-mx}px`; canvas.style.top = `${-my}px`;
        canvas.style.transform = "";
        pane.ref = ml.unproject([0, 0]); pane.z = ml.getZoom();
      };
      return { canvas, place: pane.place };
    }
    ml.on("move", () => {
      for (const p of panes) {
        if (!p.ref || Math.abs(ml.getZoom() - p.z) > 1e-6) continue;
        const q = ml.project(p.ref);
        p.canvas.style.transform = `translate(${q.x}px, ${q.y}px)`;
      }
    });

    const size = () => ({ x: box.clientWidth, y: box.clientHeight });
    return {
      engine: "maplibre",
      raw: ml,
      // Cámara y coordenadas (zoom en la escala de Leaflet)
      getZoom: () => Math.floor(ml.getZoom() + ZOFF + 1e-6),
      getBearing: () => ml.getBearing(),
      resetNorth() { ml.easeTo({ bearing: 0, duration: 300 }); return this; },
      getCenter: () => { const c = ml.getCenter(); return { lat: c.lat, lng: c.lng }; },
      getBounds() { const b = ml.getBounds(); return bounds(b.getSouth(), b.getWest(), b.getNorth(), b.getEast()); },
      getSize: size,
      getContainer: () => box,
      setView(ll, z, opts) {
        const v = { center: lngLat(ll), zoom: (z != null ? z : ml.getZoom() + ZOFF) - ZOFF };
        if (opts && opts.animate === false) ml.jumpTo(v); else ml.easeTo({ ...v, duration: 300 });
        return this;
      },
      fitPoints(pts, opts = {}) {
        if (!pts.length) return this;
        let s = 90, w = 180, n = -90, e = -180;
        for (const p of pts) { const q = toLL(p); s = Math.min(s, q.lat); n = Math.max(n, q.lat); w = Math.min(w, q.lng); e = Math.max(e, q.lng); }
        // Sin zooms enteros el encuadre queda justo al borde: un margen más para que pines y buses
        // (hasta ~20 px de radio) no queden cortados.
        const M = 20, tl = opts.paddingTopLeft || [0, 0], br = opts.paddingBottomRight || [0, 0];
        ml.fitBounds([[w, s], [e, n]], { padding: { left: tl[0] + M, top: tl[1] + M, right: br[0] + M, bottom: br[1] + M },
          maxZoom: opts.maxZoom != null ? opts.maxZoom - ZOFF : ml.getMaxZoom(), bearing: ml.getBearing(), duration: 400 });
        return this;
      },
      project: (ll, z) => { const p = toLL(ll); return worldPx(p.lat, p.lng, z); },
      unproject: (p, z) => worldLL(p, z),
      latLngToContainerPoint: (ll) => { const p = ml.project(lngLat(ll)); return { x: p.x, y: p.y }; },
      containerPointToLatLng: (p) => { const q = ml.unproject(Array.isArray(p) ? p : [p.x, p.y]); return { lat: q.lat, lng: q.lng }; },
      invalidateSize() { ml.resize(); return this; },
      isMoving: () => ml.isMoving() || ml.isZooming(),
      on(ev, fn) { on(ev, fn, false); return this; },
      once(ev, fn) { on(ev, fn, true); return this; },
      addAttribution(html) { attrs.push(html); setAttrControl(); return this; },
      stopClicks() { return this; },
      // Capas propias
      group: (pane, z) => makeGroup(z),
      circle(ll, st) {
        const c = loose().hiddenCircle(ll, st);
        return { setLatLng(p) { c.setLatLng(p); return this; }, setRadius(r) { c.setRadius(r); return this; }, show() { c.show(); return this; }, remove() { c.remove(); return this; } };
      },
      marker,
      canvasPane,
      stopLayer,
      verticalLayer,
      setNetwork, showNetwork, setSites,
      popup(o2) {
        const p = new maplibregl.Popup({ closeButton: false, className: o2.className || "", maxWidth: "none", offset: 10 });
        return {
          setLatLng(ll) { p.setLngLat(lngLat(ll)); return this; },
          setContent(el) { p.setDOMContent(el); return this; },
          open() { if (!p.isOpen()) p.addTo(ml); return this; },
          close() { p.remove(); return this; },
          isOpen: () => p.isOpen(),
        };
      },
      startBase, setBase, waterAt,
    };
  }

  // ---------- Sin mapa (sin WebGL, con el motor nuevo): aviso y la web sin mapa ----------
  function noMap(id, o) {
    const box = typeof id === "string" ? document.getElementById(id) : id;
    box.classList.add("no-map");
    document.body.classList.add("no-map-mode");   // sin mapa sobra el botón de capas
    const msg = document.createElement("p");
    msg.className = "no-map-msg";
    msg.textContent = o.noMapText || "";
    box.appendChild(msg);
    const nop = function () { return this; };
    const handle = () => ({ setLatLng: nop, getLatLng: () => toLL(o.center), show: nop, remove: nop, visible: () => false, getElement: () => null,
      setIcon: nop, setOpacity: nop, setZIndexOffset: nop, on: nop, tooltip: nop, setRadius: nop, setLatLngs: nop });
    return {
      engine: "none",
      getBearing: () => 0,
      resetNorth() { return this; },
      getZoom: () => o.zoom, getCenter: () => toLL(o.center), getBounds: () => bounds(0, 0, 0, 0),
      getSize: () => ({ x: box.clientWidth, y: box.clientHeight }), getContainer: () => box,
      setView: nop, fitPoints: nop, project: (ll, z) => { const p = toLL(ll); return worldPx(p.lat, p.lng, z); }, unproject: (p, z) => worldLL(p, z),
      latLngToContainerPoint: () => ({ x: -1e5, y: -1e5 }), containerPointToLatLng: () => toLL(o.center),
      invalidateSize: nop, isMoving: () => false, on: nop, once: nop, addAttribution: nop, stopClicks: nop,
      group: () => ({ line: handle, circle: handle, clear: nop }), circle: handle, marker: handle,
      canvasPane: () => ({ canvas: document.createElement("canvas"), place() {} }),
      popup: () => ({ setLatLng: nop, setContent: nop, open: nop, close: nop, isOpen: () => false }),
      startBase() {}, setBase() {}, waterAt: () => null,
    };
  }

  // Motor: el de siempre (Leaflet) salvo con ?mapa=nuevo (MapLibre; sin WebGL, sin mapa).
  const wantNew = () => /[?&]mapa=nuevo\b/.test(location.search);
  root.PV_MAPA = {
    wantNew,
    create(id, opts) {
      if (wantNew()) return window.maplibregl && hasWebGL() ? maplibre(id, opts) : noMap(id, opts);
      return leaflet(id, opts);
    },
  };
})(this);
