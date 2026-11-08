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

  root.PV_MAPA = {
    create(id, opts) { return leaflet(id, opts); },
  };
})(this);
