// Leaflet map wrapper (Leaflet is loaded from cdnjs in index.html; `L` is global).
// OSM + Esri World Imagery layers, markers per the design: start = green dot, cutdown = orange
// star, planned landing = red crosshair, current sonde = blue pulsing dot, device = navy dot.

import { t } from '../i18n.js';
import { esc, html } from '../util/dom.js';

const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

function starSvg(size = 22) {
  const pts = [];
  for (let i = 0; i < 16; i++) {
    const r = i % 2 ? size * 0.28 : size * 0.5, a = (i * Math.PI) / 8;
    pts.push(`${(size / 2 + r * Math.cos(a)).toFixed(1)},${(size / 2 + r * Math.sin(a)).toFixed(1)}`);
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><polygon points="${pts.join(' ')}" fill="#f6b03d" stroke="#e07b00" stroke-width="1.5"/></svg>`;
}
const crossSvg = '<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="#c0392b" stroke-width="2"/><line x1="0" y1="12" x2="24" y2="12" stroke="#c0392b" stroke-width="2"/><line x1="12" y1="0" x2="12" y2="24" stroke="#c0392b" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="#c0392b"/></svg>';

const icon = (cls, htmlStr, size) => L.divIcon({ className: '', html: htmlStr || `<div class="${cls}"></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
const ICONS = {
  start: () => icon('start-marker', null, 14),
  sonde: () => icon('sonde-marker', null, 14),
  device: () => icon('device-marker', null, 14),
  cutdown: () => icon('', starSvg(22), 22),
  landing: () => icon('', crossSvg, 24),
};

/**
 * createMap(el, opts): opts.sat initial satellite, opts.toggle show Karte/Satellit switch,
 * opts.follow keep the sonde centred, opts.zoom/center.
 */
export function createMap(el, opts = {}) {
  if (typeof L === 'undefined') { el.innerHTML = `<div class="muted" style="padding:20px">${esc(t('map.unavailable'))}</div>`; return null; }
  const map = L.map(el, { zoomControl: true, attributionControl: true, center: opts.center || [47.45, 8.56], zoom: opts.zoom || 12 });
  const layers = {
    osm: L.tileLayer(OSM, { maxZoom: 19, attribution: '© OpenStreetMap' }),
    sat: L.tileLayer(ESRI, { maxZoom: 19, attribution: 'Esri World Imagery' }),
  };
  let current = opts.sat ? 'sat' : 'osm';
  layers[current].addTo(map);
  const api = { map, follow: !!opts.follow, markers: {}, lines: {}, airspaceLayer: L.layerGroup().addTo(map) };

  // Karte / Satellit toggle in the map corner (as in the design boards)
  if (opts.toggle !== false) {
    const tog = html(`<div class="map-toggle"><div class="seg"><button type="button" data-l="osm" class="${current === 'osm' ? 'on' : ''}">${esc(t('map.map'))}</button><button type="button" data-l="sat" class="${current === 'sat' ? 'on' : ''}">${esc(t('map.sat'))}</button></div></div>`);
    tog.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) api.setLayer(b.dataset.l); });
    el.appendChild(tog);
    api.toggle = tog;
  }
  api.setLayer = (name) => {
    if (name === current || !layers[name]) return;
    map.removeLayer(layers[current]); layers[name].addTo(map); current = name;
    if (api.toggle) api.toggle.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.l === name));
  };
  const label = (marker, text, dir = 'right') => { if (text) marker.bindTooltip(text, { permanent: true, direction: dir, className: 'maplabel', offset: [8, 0] }); return marker; };
  const setMarker = (key, lat, lon, text, dir) => {
    if (lat === null || lat === undefined) { if (api.markers[key]) { map.removeLayer(api.markers[key]); delete api.markers[key]; } return; }
    if (api.markers[key]) {
      api.markers[key].setLatLng([lat, lon]);
      if (text !== undefined) { api.markers[key].unbindTooltip(); label(api.markers[key], text, dir); }
    } else api.markers[key] = label(L.marker([lat, lon], { icon: ICONS[key](), interactive: false }), text, dir).addTo(map);
  };
  const setLine = (key, latlngs, style) => {
    if (api.lines[key]) api.lines[key].setLatLngs(latlngs);
    else api.lines[key] = L.polyline(latlngs, style).addTo(map);
  };

  api.setStart = (lat, lon, text) => setMarker('start', lat, lon, text);
  api.setDevice = (lat, lon, text) => setMarker('device', lat, lon, text);
  api.setCutdown = (lat, lon, text) => setMarker('cutdown', lat, lon, text, 'top');
  api.setLanding = (lat, lon, text) => setMarker('landing', lat, lon, text, 'bottom');
  api.setSonde = (lat, lon, text) => { setMarker('sonde', lat, lon, text); if (api.follow && lat !== null) map.panTo([lat, lon], { animate: false }); };
  /** Planned trajectory: solid ascent, dashed descent (both grey-dashed in the live view). */
  api.setPlan = (points, { live = false } = {}) => {
    if (!points || !points.length) return;
    const asc = points.filter((p) => p.phase === 'ascent').map((p) => [p.lat, p.lon]);
    const desc = points.filter((p) => p.phase === 'descent').map((p) => [p.lat, p.lon]);
    if (desc.length && asc.length) desc.unshift(asc[asc.length - 1]);
    const grey = { color: '#9aa7b6', weight: 2.5, dashArray: '6 5' };
    setLine('planAsc', asc, live ? grey : { color: '#1f5fbf', weight: 3.5 });
    setLine('planDesc', desc, live ? grey : { color: '#1f5fbf', weight: 3.5, dashArray: '7 6' });
  };
  api.setActual = (records) => {
    const pts = records.filter((r) => r.lat !== null && r.lon !== null).map((r) => [r.lat, r.lon]);
    setLine('actual', pts, { color: '#1f5fbf', weight: 3 });
  };
  api.setConnector = (a, b, text) => {
    if (!a || !b) return;
    setLine('conn', [[a.lat, a.lon], [b.lat, b.lon]], { color: '#14202e', weight: 1.5, dashArray: '6 5' });
    const mid = [(a.lat + b.lat) / 2, (a.lon + b.lon) / 2];
    if (!api.markers.connLabel) api.markers.connLabel = L.marker(mid, { icon: L.divIcon({ className: '', html: '', iconSize: [1, 1] }), interactive: false }).addTo(map).bindTooltip(text, { permanent: true, direction: 'top', className: 'maplabel' });
    else { api.markers.connLabel.setLatLng(mid); api.markers.connLabel.setTooltipContent(text); }
  };
  api.setAirspaces = (list, visible = true) => {
    api.airspaceLayer.clearLayers();
    if (!visible) return;
    for (const a of list) {
      L.polygon(a.polygon, { color: '#c0392b', weight: 2, dashArray: '6 4', fillColor: '#c0392b', fillOpacity: 0.12 }).addTo(api.airspaceLayer)
        .bindTooltip(`${a.name} · ${a.lowerText}`, { permanent: true, direction: 'center', className: 'maplabel' });
    }
  };
  api.showLayer = (key, visible) => { const l = api.lines[key]; if (l) visible ? l.addTo(map) : map.removeLayer(l); };
  api.fitAll = () => {
    const items = [...Object.values(api.markers).map((m) => m.getLatLng()), ...Object.values(api.lines).flatMap((l) => l.getLatLngs())];
    if (items.length >= 2) map.fitBounds(L.latLngBounds(items).pad(0.15));
    else if (items.length === 1) map.setView(items[0], 13);
  };
  api.setFollow = (v) => { api.follow = v; };
  api.invalidate = () => setTimeout(() => map.invalidateSize(), 50);
  api.destroy = () => map.remove();
  api.invalidate();
  return api;
}
