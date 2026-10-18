// Full-screen "Detailsicht" (design/Detail.dc.html): tabs Karte / Vertikalsicht / Stüve, big
// viewer, CUTDOWN JETZT, layer checkboxes, deviation from plan, legend.

import { t } from '../i18n.js';
import { esc, html, qs, onAct, icons } from '../util/dom.js';
import { state, bus, settings, now } from '../state.js';
import { fmtInt, fmtNum, fmtTimeUTC, distanceM, bearingDeg } from '../util/format.js';
import { planAt } from '../planning.js';
import { createMap } from './map.js';
import { renderVertical } from './vertical.js';
import { renderStueve } from './stueve.js';
import { flightTime, ascentRecords } from './ascent.js';
import { manualCutdown, cutdownAvailable } from './cutdown.js';

export function mountDetail(root, ctx, tab = 'map') {
  const p = state.plan;
  const layers = state.detailLayers || (state.detailLayers = { plan: true, actual: true, airspace: true, zone: false, marks: false, follow: true });
  const el = html(`<main class="page" style="padding:16px 28px 24px 28px;gap:16px">
    <div class="${cutdownAvailable() ? '' : 'hidden'}" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><button class="btn danger" type="button" data-act="cutdown" style="min-height:56px;font-size:18px;padding:0 26px;letter-spacing:.04em">${esc(t('asc.cutdownNow'))}</button><span class="muted small">${esc(t('detail.cutNote'))}</span></div>
    <div class="row-wrap" style="gap:16px">
      <section class="viewer-big" style="flex:999 1 700px;min-width:0;background:#fff;border:1px solid var(--border);border-radius:12px;overflow:hidden"></section>
      <aside style="flex:1 1 260px;max-width:320px;display:flex;flex-direction:column;gap:12px">
        <div class="card" style="gap:4px;padding:14px 16px"><div class="k" style="margin-bottom:4px">${esc(t('detail.layers'))}</div>
          ${['plan', 'actual', 'airspace', 'zone', 'marks', 'follow'].map((k) => `<label class="chk"><input type="checkbox" name="${k}" ${layers[k] ? 'checked' : ''}> ${esc(t(`detail.layer.${k}`))}</label>`).join('')}</div>
        <div class="card dev" style="gap:0;padding:14px 16px"></div>
        <div class="card" style="gap:6px;padding:14px 16px"><div class="k">${esc(t('detail.legend'))}</div>
          <div style="display:flex;align-items:center;gap:10px;font-size:14px"><span class="dot g"></span>Start</div>
          <div style="display:flex;align-items:center;gap:10px;font-size:14px">${icons.cutdown}Cutdown</div>
          <div style="display:flex;align-items:center;gap:10px;font-size:14px">${icons.landing}${esc(t('detail.landingSite'))}</div>
          <div style="display:flex;align-items:center;gap:10px;font-size:14px"><span class="dot b"></span>${esc(t('detail.sondeNow'))}</div></div>
      </aside>
    </div></main>`);
  root.replaceChildren(el);
  const big = qs(el, '.viewer-big');
  let map = null;
  const recsFromLaunch = () => (state.launch ? state.telemetry.slice(state.launch.index) : state.telemetry).filter((x) => x.alt !== null);

  const renderView = () => {
    if (tab === 'map') {
      if (!map) {
        big.innerHTML = '<div class="mapbox full"></div>';
        map = createMap(qs(big, '.mapbox'), { center: [p.start.lat, p.start.lon], zoom: 12, follow: layers.follow });
        if (map && p.result) {
          map.setPlan(p.result.points, { live: true }); map.setAirspaces(p.result.airspaces, layers.airspace && p.showAirspace);
          map.setStart(p.start.lat, p.start.lon, `Start ${fmtTimeUTC(p.result.launchMs)}`);
          map.setCutdown(p.result.cutdown.lat, p.result.cutdown.lon, `Cutdown (${t('legend.plan')}) ${fmtTimeUTC(p.result.cutdown.ms)}`);
          map.setLanding(p.result.landing.lat, p.result.landing.lon, `${t('plan.landingAt')} (${t('legend.plan')}) ${fmtTimeUTC(p.result.landing.ms)}`);
          map.fitAll();
        }
      }
      if (map) {
        map.setActual(layers.actual ? recsFromLaunch() : []);
        map.showLayer('planAsc', layers.plan); map.showLayer('planDesc', layers.plan);
        const last = state.last;
        if (last && last.lat !== null) map.setSonde(last.lat, last.lon, `${t('asc.sondeNow')} · ${fmtInt(last.altAgl)} m AGL · ${fmtTimeUTC(last.t, true)}`);
        map.invalidate();
      }
    } else {
      if (map) { map.destroy(); map = null; }
      const recs = recsFromLaunch();
      if (tab === 'vertical') big.innerHTML = renderVertical({ plan: layers.plan ? p.result : null, records: layers.actual ? recs : [], start: p.start, airspaces: layers.airspace && p.showAirspace && p.result ? p.result.airspaces : [], cutAltAmsl: p.cutdownMode === 'alt' ? p.start.alt + p.cutAltAgl : null, w: 960, h: 620, big: true });
      else big.innerHTML = renderStueve({ records: ascentRecords().filter((x) => x.alt !== null), groundPa: state.sondeWritten ? state.sondeWritten.groundPa : null, groundAlt: p.start.alt, cloudRh: settings().cloudRh || 92, w: 960, h: 640 }).svg;
    }
  };
  const renderDeviation = () => {
    const last = state.last, r = p.result, row = (k, v) => `<div class="row"><span class="muted">${esc(k)}</span><span class="val">${v}</span></div>`;
    let body = `<div class="k" style="margin-bottom:4px">${esc(t('detail.deviation'))}</div>`;
    const ft = flightTime(last);
    const plan = r && ft !== null && last ? planAt(r, ft) : null;
    if (plan && last.lat !== null) {
      const lateral = distanceM(plan.lat, plan.lon, last.lat, last.lon);
      const side = ((bearingDeg(p.start.lat, p.start.lon, last.lat, last.lon) - r.bearing + 540) % 360) - 180;
      // time lead: how much earlier the actual altitude was reached compared to the plan
      const planIdx = r.points.findIndex((x) => x.alt >= last.alt && x.phase === 'ascent');
      const lead = planIdx >= 0 && !state.cutdown ? r.points[planIdx].t - ft : null;
      const newLanding = r.landing;
      body += row(t('detail.lateral'), `${fmtNum(lateral / 1000, 1)} km ${side > 0 ? t('detail.right') : t('detail.left')}`)
        + row(t('detail.temporal'), lead !== null ? `${lead >= 0 ? '+' : '−'}${fmtInt(Math.abs(lead))} s ${lead >= 0 ? t('detail.ahead') : t('detail.behind')}` : '–')
        + row(t('detail.altDev'), `${last.alt - plan.alt >= 0 ? '+' : '−'}${fmtInt(Math.abs(last.alt - plan.alt))} m`)
        + row(t('detail.landingNew'), `${fmtTimeUTC(newLanding.ms + (lead !== null ? -lead * 1000 : 0))} · ${fmtNum(r.distanceM / 1000, 1)} km`);
    } else body += `<div class="muted small">${esc(t('asc.noPlan'))}</div>`;
    qs(el, '.dev').innerHTML = body;
  };
  el.addEventListener('change', (e) => { if (e.target.name in layers) { layers[e.target.name] = e.target.checked; if (map) map.setFollow(layers.follow); if (map) map.setAirspaces(p.result ? p.result.airspaces : [], layers.airspace && p.showAirspace); renderView(); } });
  onAct(el, {
    cutdown: () => manualCutdown(ctx, { where: 'Detailsicht' }),
  });
  let lastHeavy = 0;
  const off = bus.on('telemetry', () => { renderDeviation(); const now = Date.now(); if (tab === 'map' || now - lastHeavy > 3000) { lastHeavy = now; renderView(); } });
  renderView(); renderDeviation();
  return {
    destroy() { off(); if (map) map.destroy(); el.remove(); },
    setTab(tb) { tab = tb; renderView(); },
    pill: () => { const l = state.last; return l ? `<span class="pill"><span class="dot g"></span>${fmtInt(l.alt)} m AMSL · ${l.rise >= 0 ? '+' : ''}${fmtNum(l.rise, 1)} m/s · ${t('asc.lastPkt')} ${t('asc.ago', { s: Math.round((now() - l.t) / 1000) })}</span>` : ''; },
  };
}
