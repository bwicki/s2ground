// Schnellstart, second half (design/SchnellstartLive.dc.html): after the launch the page shows ONE banner, three big
// tiles (Höhe über Grund · Steigrate · Bis Cutdown) and CUTDOWN JETZT; after the landing the banner turns into the
// retrieval block (distance, bearing, position, Google Maps, QR code) with «Aufstieg abschliessen & archivieren».
// Everything else keeps running exactly as in the phase flow (files, relay, log); «Vollständige Ansicht» is one click away.

import { t, tx } from '../i18n.js';
import { esc, html, qs, onAct } from '../util/dom.js';
import { state, bus, now } from '../state.js';
import { fmtInt, fmtNum, fmtDuration, distanceM, bearingDeg, fmtBearing, icaoSeconds, googleMapsNavUrl, fmtTimeUTC } from '../util/format.js';
import { landingPoint, drawQr } from './retrieve.js';
import { manualCutdown } from './cutdown.js';

const ICON = {
  ok: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16.5 9.5"/></svg>',
  warn: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3L2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>',
  pin: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true" style="flex:none"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
};
const dot = (c) => `<span class="dot ${c}"></span>`;

/** Cutdown altitude (m AGL) the sonde was programmed with, or null for «no automatic cutdown». */
function cutTarget() {
  if (state.sondeWritten) return state.sondeWritten.cutAltAgl;
  return state.plan.cutdownMode === 'alt' ? state.plan.cutAltAgl : null;
}
/** Radio state from the packet counters: g = good, y = weak, r = lost. */
function radio() {
  const age = state.packets.lastT ? (now() - state.packets.lastT) / 1000 : null;
  const loss = state.packets.rx ? (state.packets.lost / (state.packets.rx + state.packets.lost)) * 100 : 0;
  const lvl = age !== null && age < 10 && loss < 10 ? 'g' : age !== null && age < 60 ? 'y' : 'r';
  return { age, lvl, rs: state.last ? state.last.rs : null };
}
/** True when the sonde has not been climbing for 30 s (no cutdown yet, not landed, ≥ 1 min after the launch). */
function stalled() {
  if (!state.launch || state.cutdown || state.landed) return false;
  const recs = state.telemetry.slice(-30);
  return state.telemetry.length - state.launch.index >= 60 && recs.length === 30 && recs.every((r) => (r.rise ?? 0) < 0.3);
}
/** «Hier» for distance and bearing: device GPS, else the receiver, else the start. */
function hereRef() {
  const rx = state.linkState.receiver;
  return state.device || (rx && rx.lat ? { lat: rx.lat, lon: rx.lon } : null) || { lat: state.plan.start.lat, lon: state.plan.start.lon };
}
const box = (level, icon, title, sub, extra = '') => `<div class="q-status ${level}" role="status" style="${extra ? 'gap:22px;flex-wrap:wrap' : ''}">${icon}<div style="flex:1;min-width:${extra ? 280 : 0}px"><div class="big" style="font-size:24px">${title}</div><div class="sub">${sub}</div></div>${extra}</div>`;

export function mountQuickLive(host, ctx) {
  const p = state.plan;
  const el = html(`<main class="page q-page">
    <div data-f="banner"></div>
    <div class="q-tiles" data-f="tiles"></div>
    <div data-f="cutwrap" style="display:flex;flex-direction:column;gap:6px"><button class="btn danger" type="button" data-act="cutdown" style="min-height:76px;font-size:24px;letter-spacing:.04em">${esc(t('asc.cutdownNow'))}</button><span class="muted small" style="text-align:center">${esc(t('quick.cutNote'))}</span></div>
    <div data-f="archive"></div>
  </main>`);
  host.replaceChildren(el);
  const f = (k) => qs(el, `[data-f=${k}]`);
  const setHtml = (node, h) => { if (node.__h !== h) { node.__h = h; node.innerHTML = h; return true; } return false; };

  const retrieveHtml = () => {
    const lp = landingPoint();
    if (!lp) return box('bad', ICON.warn, esc(t('ret.banner.noPos')), esc(t('ret.banner.noPosSub')));
    const ref = hereRef(), pos = icaoSeconds(lp.lat, lp.lon);
    const dist = distanceM(ref.lat, ref.lon, lp.lat, lp.lon), brg = bearingDeg(ref.lat, ref.lon, lp.lat, lp.lon);
    const url = googleMapsNavUrl(lp.lat, lp.lon);
    const nav = `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener" data-act="nav" style="min-height:60px;font-size:18px">${esc(lp.estimated ? t('ret.navEst') : t('ret.nav'))}</a>`;
    const qr = `<div class="q-qr"><div class="box" data-qr>QR</div><div class="txt"><strong>${esc(t('ret.qr.title'))}</strong><span>${esc(lp.estimated ? t('ret.qr.textEst') : t('quick.land.qrText'))}</span></div></div>`;
    const where = tx('quick.land.pos', { pos: { html: `<span class="mono">${esc(pos)}</span>` } });
    if (lp.estimated) {
      return box('warn', ICON.pin, esc(t('ret.banner.lostTitle')), `${tx('ret.banner.lostSub', { time: fmtTimeUTC(lp.lastT), agl: fmtInt(lp.lastAgl), acc: fmtInt(lp.acc) })} <strong>${esc(t('ret.banner.takeRx'))}</strong> ${esc(t('ret.banner.lostSub2'))} ${where}`, nav + qr);
    }
    return box('ok', ICON.pin, tx('quick.land.title', { dist: fmtNum(dist / 1000, 1), brg: fmtBearing(brg) }), `${esc(t('quick.land.sub'))} ${where}`, nav + qr);
  };

  const bannerHtml = () => {
    const last = state.last, r = radio(), cut = cutTarget();
    if (state.landed || (state.cutdown && state.lostInDescent)) return retrieveHtml();
    if (r.age !== null && r.age > 60) return box('warn', ICON.warn, esc(t('asc.banner.lostTitle', { s: fmtDuration(r.age) })), esc(t('asc.banner.lostSub')));
    if (state.cutdown) return box('ok', ICON.ok, esc(t('asc.banner.descTitle', { alt: fmtInt(state.cutdown.altAgl) })), esc(t('asc.banner.descSub', { rate: fmtNum(Math.abs(last ? last.rise : 0), 1) })));
    if (stalled()) return box('warn', ICON.warn, esc(t('quick.live.stalledTitle')), esc(t('quick.live.stalledSub')));
    const rise = last ? last.rise : 0;
    const sub = cut === null ? t('quick.live.okSubNoCut')
      : last && rise > 0.3 && last.altAgl !== null ? t('quick.live.okSub', { alt: fmtInt(cut), min: Math.max(0, Math.round((cut - last.altAgl) / rise / 60)) })
        : t('quick.live.okSubNoEta', { alt: fmtInt(cut) });
    return box('ok', ICON.ok, esc(t('quick.live.okTitle')), esc(sub));
  };

  const tilesHtml = () => {
    const last = state.last;
    if (!last) return `<div class="q-tile" style="grid-column:1/-1"><span class="u">${esc(t('asc.noData'))}</span></div>`;
    const rise = last.rise ?? 0, r = radio(), cut = cutTarget();
    const planRise = state.cutdown ? -p.descentRate : p.riseRate, dev = rise - planRise;
    const [dotAlt, txtAlt] = state.cutdown ? ['g', 'quick.cmp.falling'] : rise < 0.3 ? ['r', 'quick.cmp.flat'] : Math.abs(dev) < 1 ? ['g', 'quick.cmp.rising'] : dev < 0 ? ['y', 'quick.cmp.slow'] : ['y', 'quick.cmp.fast'];
    const what = Math.abs(dev) < 1 ? t('quick.cmp.normal') : dev < 0 ? t('quick.cmp.tooSlow') : t('quick.cmp.tooFast');
    const toCut = cut !== null && !state.cutdown && rise > 0.3 ? (cut - last.altAgl) / rise : null;
    const toLand = state.cutdown && !state.landed && rise < -0.3 ? -last.altAgl / rise : null;
    const mins = toCut !== null ? toCut : toLand;
    const radioTxt = r.lvl === 'g' ? (r.rs !== null ? t('quick.cmp.radioGood', { dbm: fmtInt(r.rs) }) : t('quick.cmp.radioGoodNoDbm')) : r.lvl === 'y' ? t('quick.cmp.radioWeak') : t('quick.cmp.radioLost', { s: r.age !== null ? fmtDuration(r.age) : '–' });
    return `<div class="q-tile hl"><span class="k">${esc(t('quick.tile.alt'))}</span><div class="vu"><span class="v">${fmtInt(last.altAgl)}</span><span class="u">m AGL</span></div><span class="u">${fmtInt(last.alt)} m AMSL</span><div class="cmp">${dot(dotAlt)}${esc(t(txtAlt))}</div></div>
      <div class="q-tile"><span class="k">${esc(t('asc.tile.rise'))}</span><div class="vu"><span class="v">${rise >= 0 ? '+' : ''}${fmtNum(rise, 1)}</span><span class="u">m/s</span></div><span class="u">&nbsp;</span><div class="cmp">${dot(Math.abs(dev) < 1 ? 'g' : 'y')}${esc(t('quick.cmp.rate', { what, rate: fmtNum(planRise, 1) }))}</div></div>
      <div class="q-tile"><span class="k">${esc(state.cutdown ? t('asc.tile.toLanding') : t('asc.tile.toCutdown'))}</span><div class="vu"><span class="v">${mins !== null ? `≈ ${Math.max(0, Math.round(mins / 60))}` : '–'}</span><span class="u">min</span></div><span class="u">${esc(state.cutdown ? t('quick.tile.cutDone', { alt: fmtInt(state.cutdown.altAgl) }) : cut === null ? t('quick.tile.noCut') : t('quick.tile.cutAt', { alt: fmtInt(cut) }))}</span><div class="cmp">${dot(r.lvl)}${esc(radioTxt)}</div></div>`;
  };

  const paint = () => {
    const landed = !!state.landed;
    setHtml(f('banner'), bannerHtml());
    const qrBox = qs(el, '[data-qr]');
    if (qrBox) { const lp = landingPoint(); if (lp) drawQr(qrBox, googleMapsNavUrl(lp.lat, lp.lon), 90); }
    setHtml(f('tiles'), tilesHtml());
    f('tiles').classList.toggle('hidden', landed);
    f('cutwrap').classList.toggle('hidden', landed);
    setHtml(f('archive'), landed ? `<button class="btn primary big" type="button" data-act="archive" style="align-self:flex-start">${esc(t('ret.archiveBtn'))}</button>` : '');
  };
  onAct(el, {
    cutdown: () => manualCutdown(ctx, { where: 'Schnellstart' }),
    archive: () => ctx.archive('quick'),
  });
  el.addEventListener('click', (e) => { if (e.target.closest('[data-act=nav]')) ctx.log('navigate', 'Google Maps'); });   // the link itself must open
  const offs = [bus.on('telemetry', paint), bus.on('landed', () => { paint(); ctx.refreshHeader(); }), bus.on('device', paint)];
  const timer = setInterval(() => { paint(); ctx.refreshHeader(); }, 2000);
  paint();
  return {
    destroy() { clearInterval(timer); offs.forEach((o) => o()); el.remove(); },
    header() {
      const r = radio(), obs = state.relay.presence.filter((u) => u.role === 'observer').length;
      const since = state.launch ? fmtDuration((now() - state.launch.t) / 1000) : '–';
      const first = state.landed ? `<span class="pill green"><span class="dot g"></span>${esc(t('quick.hdr.landed'))}</span>` : `<span class="pill green"><span class="dot g"></span>${tx('quick.hdr.running', { since: { html: `<span class="mono">${esc(since)}</span>` } })}</span>`;
      const ago = r.age !== null ? Math.round(r.age) : '–';
      const second = `<span class="pill">${dot(r.lvl)}${esc(t(r.lvl === 'g' ? 'quick.hdr.radioGood' : r.lvl === 'y' ? 'quick.hdr.radioWeak' : 'quick.hdr.radioLost', { s: ago }))}</span>`;
      const third = `<span class="pill">${dot('b')}${esc(t(obs === 0 ? 'quick.hdr.obs0' : obs === 1 ? 'quick.hdr.obs1' : 'quick.hdr.obsN', { n: obs }))}</span>`;
      return `${first}${second}${third}<a href="#ascent">${esc(t('quick.toFull'))}</a>`;
    },
  };
}
