// Phase 4 – "Aufstieg" (design/Aufstieg.dc.html): live tiles with Soll-Ist line, map +
// vertical view + Stüve viewers with "Detailsicht", CUTDOWN JETZT, chat with quick replies.

import { t } from '../i18n.js';
import { esc, html, qs, onAct, banner } from '../util/dom.js';
import { state, bus, setPhaseStatus, settings, now } from '../state.js';
import { fmtInt, fmtNum, fmtTimeUTC, fmtDuration, mToFt, msToKt, windFromCourse, fmtBearing, distanceM, icaoSeconds } from '../util/format.js';
import { planAt, profileAt } from '../planning.js';
import { createMap } from './map.js';
import { renderVertical } from './vertical.js';
import { renderStueve } from './stueve.js';
import { mountChat } from './chat.js';
import { manualCutdown, cutdownAvailable } from './cutdown.js';

const dot = (ok, warn) => `<span class="dot ${ok ? 'g' : warn ? 'y' : 'r'}"></span>`;
const tile = (k, v, u, cmp, extra = '', cls = '') => `<div class="tile ${cls}"><span class="k">${esc(k)}</span><div class="vals"><div class="vu"><span class="v">${v}</span><span class="u">${u}</span></div></div>${extra}<div class="cmp">${cmp}</div></div>`;

/** Records of the ascent only (launch → peak): the Stüve shows the sounding, not the descent. */
export function ascentRecords() {
  const recs = state.launch ? state.telemetry.slice(state.launch.index) : state.telemetry;
  if (!state.peak) return recs;
  const i = recs.findIndex((r) => r.t >= state.peak.t);
  return i > 0 ? recs.slice(0, i + 1) : recs;
}

/** Seconds since launch (plan time axis), null before launch. */
export function flightTime(rec) { return state.launch && rec ? (rec.t - state.launch.t) / 1000 : null; }

export function updateAscentStatus() {
  const age = state.packets.lastT ? (now() - state.packets.lastT) / 1000 : null;
  if (state.landed) setPhaseStatus('ascent', 'ok', t('asc.status.landed'));
  else if (!state.launch) setPhaseStatus('ascent', 'warn', t('asc.status.waiting'));
  else if (age !== null && age > 60) setPhaseStatus('ascent', 'warn', t('asc.status.noContact', { s: fmtInt(age) }));
  else setPhaseStatus('ascent', 'warn', state.cutdown ? t('asc.status.descending') : t('asc.status.running'));
}

export function ascentExpert(ctx) {
  const last = state.last, row = (k, v) => `<div class="row"><span class="muted">${esc(k)}</span><span class="val">${v}</span></div>`;
  return {
    title: t('asc.expert.title'),
    body: row('RSSI / SNR', last && last.rs !== null ? `${fmtInt(last.rs)} dBm / ${fmtInt(last.snr)} dB` : '–')
      + row(t('asc.expert.packets'), `${fmtInt(state.packets.rx)} / ${fmtInt(state.packets.lost)}`)
      + row('Position', last && last.lat !== null ? icaoSeconds(last.lat, last.lon) : '–')
      + row(t('asc.expert.pressure'), last ? `${fmtInt(last.pa / 100)} hPa` : '–')
      + row(t('chk.expert.battery'), last ? `${fmtNum(last.su, 2)} V` : '–')
      + row(t('prep.expert.power'), state.linkState.sonde ? `${state.linkState.sonde.powerDbm} dBm` : '–')
      + row('Relay s2stueve', state.relay.connected ? t('asc.expert.sent', { n: fmtInt(state.relay.sent) }) : t('prep.expert.relayOff'))
      + row(t('asc.expert.cloudRh'), `<input class="in mono sm" name="cloudRh" type="number" min="50" max="100" value="${settings().cloudRh || 92}" style="width:90px;text-align:right"> %`)
      + row(t('chk.expert.raw'), `<a href="#" data-act="log">${esc(t('hdr.protocol'))}</a>`)
      + row(t('asc.expert.files'), `<a href="#" data-act="csv">CSV</a> · <a href="#" data-act="snd">.sounding</a>${state.files.folder ? ` · <span class="muted">${esc(state.files.folder)}</span>` : ''}`),
    bind(panel) {
      panel.addEventListener('change', (e) => { if (e.target.name === 'cloudRh') { settings().cloudRh = Number(e.target.value); bus.emit('settings'); } });
      onAct(panel, { log: () => ctx.showLog(), csv: () => ctx.downloadFiles('csv'), snd: () => ctx.downloadFiles('sounding') });
    },
  };
}

export function mountAscent(root, ctx) {
  const p = state.plan;
  const el = html(`<main class="page" style="padding:20px 28px;gap:16px"><div class="bannerbox"></div>
    <div class="row-wrap">
      <section style="flex:999 1 620px;min-width:0;display:flex;flex-direction:column;gap:14px">
        <div class="tiles"></div>
        <div class="viewers2">
          <details class="viewer" open><summary><span>${esc(t('asc.viewer.map'))}</span><span class="tools"><a class="btn xs" href="#detail/map">${esc(t('asc.detail'))} ⤢</a></span></summary><div class="mapbox"></div></details>
          <details class="viewer" open><summary><span>${esc(t('asc.viewer.vertical'))}</span><span class="tools"><a class="btn xs" href="#detail/vertical">${esc(t('asc.detail'))} ⤢</a></span></summary><div class="vertbox"></div></details>
        </div>
        <div class="cutwrap" style="display:flex;flex-direction:column;gap:6px"><button class="btn danger big" type="button" data-act="cutdown" style="width:100%;min-height:68px;font-size:22px;letter-spacing:.04em">${esc(t('asc.cutdownNow'))}</button><span class="muted small" style="text-align:center">${esc(t('asc.cutdownNote'))}</span></div>
        <details class="viewer" open><summary><span>${esc(t('asc.viewer.stueve'))}</span><span class="tools"><a class="btn xs" href="#detail/stueve">${esc(t('asc.detail'))} ⤢</a></span></summary>
          <div class="stueve-wrap"><div class="stbox"></div><div class="derived" style="display:flex;flex-direction:column;gap:8px"></div></div></details>
      </section>
      <div class="chatslot" style="display:contents"></div>
    </div></main>`);
  root.replaceChildren(el);
  const map = createMap(qs(el, '.mapbox'), { center: [p.start.lat, p.start.lon], zoom: 12, follow: true });
  if (map && p.result) {
    map.setPlan(p.result.points, { live: true });
    map.setAirspaces(p.result.airspaces, p.showAirspace);
    map.setStart(p.start.lat, p.start.lon, 'Start');
    map.setCutdown(p.result.cutdown.lat, p.result.cutdown.lon, `Cutdown (${t('legend.plan')})`);
    map.setLanding(p.result.landing.lat, p.result.landing.lon, `${t('plan.landingAt')} (${t('legend.plan')})`);
    map.fitAll(); map.setFollow(false);
  }
  const chat = mountChat(qs(el, '.chatslot'), ctx);

  const renderBanner = () => {
    updateAscentStatus();
    const box = qs(el, '.bannerbox'), last = state.last;
    const age = state.packets.lastT ? (now() - state.packets.lastT) / 1000 : null;
    const obs = state.relay.presence.length;
    if (!state.launch) { box.innerHTML = banner({ level: 'info', title: t('asc.banner.waitTitle'), sub: t('asc.banner.waitSub') }); return; }
    if (age !== null && age > 60 && !state.landed) { box.innerHTML = banner({ level: 'warn', title: t('asc.banner.lostTitle', { s: fmtDuration(age) }), sub: t('asc.banner.lostSub') }); return; }
    if (state.landed) { box.innerHTML = banner({ level: 'ok', title: t('asc.banner.landedTitle'), sub: t('asc.banner.landedSub') }); return; }
    const since = fmtDuration((now() - state.launch.t) / 1000);
    if (state.cutdown) { box.innerHTML = banner({ level: 'ok', title: t('asc.banner.descTitle', { alt: fmtInt(state.cutdown.altAgl) }), sub: t('asc.banner.descSub', { rate: fmtNum(Math.abs(last ? last.rise : 0), 1) }) }); return; }
    let cutTxt = p.cutdownMode === 'alt' ? t('asc.banner.autoCut', { alt: fmtInt(p.cutAltAgl) }) : t('asc.banner.noCut');
    if (p.cutdownMode === 'alt' && last && last.rise > 0.3 && last.altAgl !== null) cutTxt += ` (${t('asc.inAbout', { min: Math.max(0, Math.round((p.cutAltAgl - last.altAgl) / last.rise / 60)) })})`;
    box.innerHTML = banner({ level: 'ok', title: t('asc.banner.runTitle', { since }), sub: `${t('asc.banner.radioOk')} · ${t('asc.banner.observers', { n: obs })} · ${cutTxt}` });
  };

  const renderTiles = () => {
    const last = state.last, r = p.result;
    if (!last) { qs(el, '.tiles').innerHTML = `<div class="tile span4 muted">${esc(t('asc.noData'))}</div>`; return; }
    const ft = flightTime(last);
    const plan = r && ft !== null ? planAt(r, ft) : null;
    const planAlt = plan ? plan.alt : null;
    const altOk = planAlt !== null ? Math.abs(last.alt - planAlt) : 0;
    const lvl = r && ft !== null ? profileAt(r.levels, last.alt) : null;
    const windDir = windFromCourse(last.ang), windKt = last.spd !== null ? msToKt(last.spd) : null;
    const dist = last.lat !== null ? distanceM(p.start.lat, p.start.lon, last.lat, last.lon) : null;
    const planDist = plan ? distanceM(p.start.lat, p.start.lon, plan.lat, plan.lon) : null;
    const toCut = p.cutdownMode === 'alt' && !state.cutdown && last.rise > 0.3 ? (p.cutAltAgl - last.altAgl) / last.rise : null;
    const toLand = state.cutdown && !state.landed && last.rise < -0.3 ? -last.altAgl / last.rise : null;
    const age = state.packets.lastT ? Math.round((now() - state.packets.lastT) / 1000) : null;
    const bars = (rs) => { const n = rs === null ? 0 : rs > -70 ? 5 : rs > -85 ? 4 : rs > -100 ? 3 : rs > -110 ? 2 : 1; return `<svg width="34" height="20" viewBox="0 0 34 20" style="align-self:center">${[0, 1, 2, 3, 4].map((i) => `<rect x="${i * 7}" y="${14 - i * 3}" width="5" height="${6 + i * 3}" fill="${i < n ? '#1f8a4c' : '#d9dee6'}"/>`).join('')}</svg>`; };
    const lossPct = state.packets.rx ? (state.packets.lost / (state.packets.rx + state.packets.lost)) * 100 : 0;
    qs(el, '.tiles').innerHTML = `
      <div class="tile span2 hl"><span class="k">${esc(t('asc.tile.alt'))}</span><div class="vals"><div class="vu"><span class="v xl">${fmtInt(last.alt)}</span><span class="u">m AMSL</span></div><div class="vu"><span class="v xl">${fmtInt(last.altAgl)}</span><span class="u">m AGL</span></div></div><span class="u">${fmtInt(mToFt(last.alt))} ft${p.cutdownMode === 'alt' ? ` · ${t('asc.cutAt', { alt: fmtInt(p.cutAltAgl) })}` : ''}</span><div class="cmp">${dot(altOk < 150, altOk < 400)}<span>${planAlt !== null ? `${t('legend.plan')} ${fmtInt(planAlt)} m AMSL · ${fmtInt(planAlt - p.start.alt)} m AGL` : t('asc.noPlan')}</span></div></div>
      ${tile(t('asc.tile.rise'), (last.rise >= 0 ? '+' : '') + fmtNum(last.rise, 1), 'm/s', `${dot(Math.abs(last.rise - (state.cutdown ? -p.descentRate : p.riseRate)) < 0.8, true)}<span>${t('legend.plan')} ${state.cutdown ? '−' + fmtNum(p.descentRate, 1) : fmtNum(p.riseRate, 1)} m/s</span>`)}
      ${tile(t('asc.tile.wind'), windDir !== null ? `${fmtBearing(windDir)} / ${fmtInt(windKt)}` : '–', 'kt', lvl ? `${dot(Math.abs(msToKt(lvl.spd) - (windKt || 0)) < 5, Math.abs(msToKt(lvl.spd) - (windKt || 0)) < 10)}<span>${t('legend.plan')} ${fmtBearing(lvl.dir)} / ${fmtInt(msToKt(lvl.spd))} kt</span>` : '<span class="dot x"></span>–', '', '')}
      ${tile(t('asc.tile.temp'), fmtNum(last.te, 1), '°C', lvl ? `${dot(Math.abs(lvl.tC - last.te) < 3, true)}<span>${t('asc.model')} ${fmtNum(lvl.tC, 1)} °C</span>` : '<span class="dot x"></span>–')}
      ${tile(t('asc.tile.hum'), fmtInt(last.hu), '% RH', lvl ? `${dot(Math.abs(lvl.rh - last.hu) < 15, true)}<span>${t('asc.model')} ${fmtInt(lvl.rh)} %</span>` : '<span class="dot x"></span>–')}
      ${tile(t('asc.tile.dist'), dist !== null ? fmtNum(dist / 1000, 1) : '–', 'km', planDist !== null ? `${dot(Math.abs(planDist - dist) < 500, true)}<span>${t('legend.plan')} ${fmtNum(planDist / 1000, 1)} km · ${fmtBearing(r.bearing)}</span>` : '<span class="dot x"></span>–')}
      ${tile(state.cutdown ? t('asc.tile.toLanding') : t('asc.tile.toCutdown'), toCut !== null ? `≈ ${Math.max(0, Math.round(toCut / 60))}` : toLand !== null ? `≈ ${Math.max(0, Math.round(toLand / 60))}` : '–', 'min', r ? `${dot(true)}<span>${t('legend.plan')} ${fmtTimeUTC(state.cutdown ? r.landing.ms : r.cutdown.ms)} UTC</span>` : '<span class="dot x"></span>–')}
      <div class="tile span4"><span class="k">${esc(t('asc.tile.radio'))}</span><div class="grid4">
        <div class="cell"><span class="u">${esc(t('asc.signal'))}</span><div class="vu" style="gap:8px"><span class="v md">${last.rs !== null ? fmtInt(last.rs) : '–'}</span><span class="u">dBm</span>${bars(last.rs)}</div></div>
        <div class="cell"><span class="u">${esc(t('asc.pktRx'))}</span><div class="vu"><span class="v md">${fmtInt(state.packets.rx)}</span></div></div>
        <div class="cell"><span class="u">${esc(t('asc.pktLost'))}</span><div class="vu"><span class="v md">${fmtInt(state.packets.lost)}</span><span class="u">(${fmtNum(lossPct, 1)} %)</span></div></div>
        <div class="cell"><span class="u">${esc(t('asc.lastPkt'))}</span><div class="vu"><span class="v md">${age !== null ? t('asc.ago', { s: age }) : '–'}</span></div></div>
      </div><div class="cmp">${dot(age !== null && age < 10 && lossPct < 10, age !== null && age < 60)}<span>${age !== null && age < 10 ? t('asc.radioGood') : t('asc.radioWeak')}</span></div></div>`;
  };

  let lastHeavy = 0;
  const renderViewers = (force = false) => {
    const wall = Date.now();
    if (!force && wall - lastHeavy < 4000) return;
    lastHeavy = wall;
    const recs = state.telemetry.filter((x) => x.alt !== null);
    qs(el, '.vertbox').innerHTML = renderVertical({ plan: p.result, records: state.launch ? recs.slice(state.launch.index) : [], start: p.start, airspaces: p.showAirspace && p.result ? p.result.airspaces : [], cutAltAmsl: p.cutdownMode === 'alt' ? p.start.alt + p.cutAltAgl : null });
    const st = renderStueve({ records: ascentRecords().filter((x) => x.alt !== null), groundPa: state.sondeWritten ? state.sondeWritten.groundPa : null, groundAlt: p.start.alt, cloudRh: settings().cloudRh || 92, w: 640, h: 300, compact: true });
    qs(el, '.stbox').innerHTML = st.svg;
    const d = st.derived, row = (k, v) => `<div class="row"><span class="muted">${esc(k)}</span><span class="val">${v}</span></div>`;
    qs(el, '.derived').innerHTML = `<div class="k">${esc(t('asc.derived'))}</div>${row(t('asc.inversion'), d.inversion ? `${fmtInt(d.inversion[0])}–${fmtInt(d.inversion[1])} m` : '–')}${row(t('asc.cloudBase', { rh: settings().cloudRh || 92 }), d.cloudBase !== null ? `≈ ${fmtInt(d.cloudBase)} m` : '–')}${row(t('asc.zeroLevel'), d.zeroLevel !== null ? `≈ ${fmtInt(d.zeroLevel)} m` : '–')}${row(t('asc.wind850'), d.wind850 ? `${fmtBearing(d.wind850.dir)} / ${fmtInt(d.wind850.kt)} kt` : '–')}`;
    if (map) map.setActual(state.launch ? state.telemetry.slice(state.launch.index) : []);
  };
  const onTelemetry = (rec) => {
    renderTiles(); renderBanner();
    const cw = qs(el, '.cutwrap'); if (cw) cw.classList.toggle('hidden', !cutdownAvailable());
    if (map && rec.lat !== null) map.setSonde(rec.lat, rec.lon, `${t('asc.sondeNow')} · ${fmtInt(rec.altAgl)} m AGL`);
    renderViewers();
  };
  onAct(el, { cutdown: () => manualCutdown(ctx) });
  const offs = [bus.on('telemetry', onTelemetry), bus.on('presence', renderBanner), bus.on('relay', renderBanner), bus.on('settings', () => renderViewers(true)), bus.on('landed', () => { renderBanner(); renderTiles(); })];
  const timer = setInterval(() => { renderBanner(); renderTiles(); }, 2000);
  renderTiles(); renderBanner(); renderViewers(true);
  return { destroy() { offs.forEach((f) => f()); clearInterval(timer); chat.destroy(); if (map) map.destroy(); el.remove(); }, expert: () => ascentExpert(ctx) };
}
