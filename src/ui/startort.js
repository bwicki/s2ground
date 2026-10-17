// "Startort aus Karte wählen" dialog (design/Startort.dc.html): map with a fixed crosshair,
// place search (Nominatim), "Mein Standort" (device GPS), ground elevation (Open-Meteo DEM).

import { t } from '../i18n.js';
import { esc, html, qs, onAct, toast } from '../util/dom.js';
import { icaoShort, icaoSeconds, fmtInt } from '../util/format.js';
import { createMap } from './map.js';

async function elevation(lat, lon) {
  try {
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}`, { signal: ctrl.signal });
    const j = await r.json();
    return Math.round(j.elevation[0]);
  } catch { return null; }
}
async function geocode(q) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
    const j = await r.json();
    return j[0] ? { lat: +j[0].lat, lon: +j[0].lon, name: j[0].display_name.split(',')[0] } : null;
  } catch { return null; }
}

/** Resolves with {lat, lon, alt, name} or null (cancelled). */
export function openStartort(initial, device) {
  return new Promise((resolve) => {
    const cross = '<svg class="crosshair" viewBox="0 0 48 48" aria-hidden="true"><g stroke="#14202e" stroke-width="2" fill="none"><line x1="24" y1="0" x2="24" y2="48"/><line x1="0" y1="24" x2="48" y2="24"/><circle cx="24" cy="24" r="16"/></g><circle cx="24" cy="24" r="6" fill="#1f8a4c" stroke="#fff" stroke-width="2"/></svg>';
    const bg = html(`<div class="modal-bg"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(t('startort.title'))}">
      <div class="head"><h1>${esc(t('startort.title'))}</h1><button class="btn icon" type="button" data-act="cancel" aria-label="${esc(t('common.close'))}">×</button></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><input class="in" type="text" name="q" placeholder="${esc(t('startort.searchPh'))}" aria-label="${esc(t('startort.search'))}" style="flex:1;min-width:260px"><button class="btn" type="button" data-act="search">${esc(t('startort.search'))}</button><button class="btn" type="button" data-act="me">${esc(t('startort.myLocation'))}</button></div>
      <div class="mapbox">${cross}</div>
      <p class="muted" style="margin:0;text-align:center;font-size:13px">${esc(t('startort.dragHint'))}</p>
      <div class="stats3">
        <div><div class="k">${esc(t('startort.icao'))}</div><div class="val" data-f="icao">–</div></div>
        <div><div class="k">${esc(t('startort.icaoSec'))}</div><div class="val" data-f="icaoSec">–</div></div>
        <div><div class="k">${esc(t('startort.groundAlt'))}</div><div class="val" data-f="alt">–</div></div>
      </div>
      <div class="foot"><button class="btn" type="button" data-act="cancel">${esc(t('common.cancel'))}</button><button class="btn primary" type="button" data-act="ok">${esc(t('startort.apply'))}</button></div>
    </section></div>`);
    document.body.appendChild(bg);
    const box = qs(bg, '.mapbox');
    const m = createMap(box, { center: [initial.lat, initial.lon], zoom: 14 });
    let cur = { ...initial }; let altTimer = null;
    const show = () => {
      qs(bg, '[data-f=icao]').textContent = icaoShort(cur.lat, cur.lon);
      qs(bg, '[data-f=icaoSec]').textContent = icaoSeconds(cur.lat, cur.lon);
      qs(bg, '[data-f=alt]').textContent = cur.alt !== null && cur.alt !== undefined ? `${fmtInt(cur.alt)} m AMSL` : '…';
    };
    const moved = () => {
      if (!m) return;
      const c = m.map.getCenter(); cur.lat = c.lat; cur.lon = c.lng; cur.alt = null; show();
      clearTimeout(altTimer);
      altTimer = setTimeout(async () => { const a = await elevation(cur.lat, cur.lon); cur.alt = a ?? initial.alt; show(); }, 600);
    };
    if (m) {
      m.map.on('moveend', moved);
      if (device) m.setDevice(device.lat, device.lon, t('startort.device'));
    }
    show();
    const done = (v) => { clearTimeout(altTimer); if (m) m.destroy(); bg.remove(); resolve(v); };
    onAct(bg, {
      cancel: () => done(null),
      ok: () => done({ ...cur, alt: cur.alt ?? initial.alt, name: cur.name || initial.name, source: 'map' }),
      search: async () => {
        const q = qs(bg, 'input[name=q]').value.trim(); if (!q) return;
        const r = await geocode(q);
        if (!r) { toast(t('startort.notFound'), true); return; }
        cur.name = r.name; if (m) m.map.setView([r.lat, r.lon], 14);
      },
      me: () => {
        if (!navigator.geolocation) { toast(t('startort.noGps'), true); return; }
        navigator.geolocation.getCurrentPosition((p) => { if (m) { m.setDevice(p.coords.latitude, p.coords.longitude, t('startort.device')); m.map.setView([p.coords.latitude, p.coords.longitude], 15); } }, () => toast(t('startort.noGps'), true), { enableHighAccuracy: true, timeout: 8000 });
      },
    });
    bg.addEventListener('click', (e) => { if (e.target === bg) done(null); });
  });
}
