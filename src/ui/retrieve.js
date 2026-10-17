// Phase 5 – "Sonde bergen" (design/Retrieve.dc.html): landing banner (known position, or the
// "signal lost in descent" variant with an estimated point), Google Maps navigation + QR code
// for the phone, overview map, satellite close-up that follows the sonde, position tiles.

import { t } from '../i18n.js';
import { esc, html, qs, onAct, banner, toast, copyText } from '../util/dom.js';
import { state, bus, setPhaseStatus, now } from '../state.js';
import { fmtInt, fmtNum, fmtTimeUTC, fmtDuration, distanceM, bearingDeg, fmtBearing, icaoSeconds, googleMapsNavUrl } from '../util/format.js';
import { predict, profileAt } from '../planning.js';
import { createMap } from './map.js';

/** Last known sonde position, or an estimate continued from the last packet when the signal was lost. */
export function landingPoint() {
  const last = [...state.telemetry].reverse().find((r) => r.lat !== null);
  if (!last) return null;
  if (state.landed || !state.lostInDescent) return { lat: last.lat, lon: last.lon, alt: last.alt, t: last.t, estimated: false, acc: 8 };
  const p = state.plan, levels = p.result ? p.result.levels : [];
  const est = predict({ start: { lat: last.lat, lon: last.lon, alt: last.alt }, cutAltAgl: null, burstAltAmsl: last.alt, descentRate: p.descentRate, levels, launchMs: last.t });
  // descent continues to the ground altitude of the launch site (flat-terrain assumption)
  const pt = est.points.find((x) => x.alt <= p.start.alt) || est.points[est.points.length - 1];
  return { lat: pt.lat, lon: pt.lon, alt: p.start.alt, t: last.t, estimated: true, acc: 600, lastAgl: last.altAgl, lastT: last.t };
}

/**
 * QR code of `url` into `box` (qrcodejs from cdnjs; placeholder text when the library did not load).
 * The generated node is cached per url+size, so a banner that re-renders every few seconds can put the same code
 * into its fresh box instead of showing an empty one.
 */
const qrCache = { key: null, node: null };
export function drawQr(box, url, size = 120) {
  if (!box) return;
  if (typeof QRCode === 'undefined') { box.textContent = 'QR'; return; }
  const key = `${size}:${url}`;
  if (qrCache.key !== key || !qrCache.node) {
    const holder = document.createElement('div');
    new QRCode(holder, { text: url, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });
    qrCache.key = key; qrCache.node = holder;
  }
  box.replaceChildren(qrCache.node);
}

export function updateRetrieveStatus() {
  const lp = landingPoint();
  if (!lp) setPhaseStatus('retrieve', 'bad', t('ret.status.noPos'));
  else if (lp.estimated) setPhaseStatus('retrieve', 'warn', t('ret.status.estimated'));
  else setPhaseStatus('retrieve', 'ok', t('ret.status.ok'));
}

export function retrieveExpert(ctx) {
  const last = state.last, row = (k, v) => `<div class="row"><span class="muted">${esc(k)}</span><span class="val">${v}</span></div>`;
  const sinceLanding = state.landed ? state.telemetry.filter((r) => r.t >= state.landed.t).length : 0;
  const lp = landingPoint(), r = state.plan.result;
  return {
    title: t('ret.expert.title'),
    body: row(t('ret.expert.rssi'), last && last.rs !== null ? `${fmtInt(last.rs)} dBm` : '–')
      + row(t('ret.expert.sinceLanding'), fmtInt(sinceLanding))
      + row(t('chk.expert.battery'), last ? `${fmtNum(last.su, 2)} V · ca. ${fmtNum((last.su - 3.4) * 6, 1)} h` : '–')
      + row(t('ret.expert.landingAlt'), lp ? `${fmtInt(lp.alt)} m AMSL` : '–')
      + row(t('ret.expert.deviation'), lp && r ? `${fmtNum(distanceM(lp.lat, lp.lon, r.landing.lat, r.landing.lon) / 1000, 1)} km` : '–')
      + row(t('ret.expert.scan'), state.linkState.port === 'open' ? t('ret.expert.scanOn') : t('prep.expert.closed'))
      + row(t('asc.expert.files'), `<a href="#" data-act="csv">CSV</a> · <a href="#" data-act="snd">.sounding</a> · <a href="#" data-act="kml">KML</a>`)
      + row('s2stueve', `${fmtInt(state.relay.sent)} ${t('ret.expert.points')}`)
      + row(t('chk.expert.raw'), `<a href="#" data-act="log">${esc(t('hdr.protocol'))}</a>`),
    bind(panel) { onAct(panel, { log: () => ctx.showLog(), csv: () => ctx.downloadFiles('csv'), snd: () => ctx.downloadFiles('sounding'), kml: () => ctx.downloadFiles('kml') }); },
  };
}

export function mountRetrieve(root, ctx) {
  const p = state.plan;
  const el = html(`<main class="page" style="padding:20px 28px;gap:16px"><div class="bannerbox"></div>
    <div class="row-wrap">
      <section class="card tight" style="flex:999 1 560px">
        <div class="card-head"><h2>${esc(t('ret.overview'))}</h2><span class="muted small">${esc(t('ret.overviewNote'))}</span></div>
        <div class="mapbox" style="height:400px;border-radius:8px;overflow:hidden"></div>
        <div class="card-head" style="border-top:1px solid var(--hair);padding-top:10px"><h2>${esc(t('ret.closeup'))}</h2><span class="muted small">${esc(t('ret.closeupNote'))}</span></div>
        <div class="mapbox sat" style="border-radius:8px;overflow:hidden"></div>
      </section>
      <aside style="flex:1 1 320px;display:flex;flex-direction:column;gap:12px">
        <div class="tile"><span class="k">${esc(t('ret.fromMe'))}</span><div class="grid3">
          <div class="cell"><span class="u">${esc(t('ret.distance'))}</span><div class="vu" style="gap:5px"><span class="v" data-f="dist">–</span><span class="u">km</span></div></div>
          <div class="cell"><span class="u">${esc(t('ret.bearing'))}</span><div class="vu"><span class="v" data-f="brg">–</span></div></div>
          <div class="cell"><span class="u">${esc(t('ret.driveTime'))}</span><div class="vu" style="gap:5px"><span class="v" data-f="drive">–</span><span class="u">min</span></div></div></div></div>
        <div class="tile"><span class="k">${esc(t('ret.position'))}</span><span class="v md" data-f="pos">–</span><span class="u" data-f="posNote"></span></div>
        <div class="tile"><span class="k">${esc(t('ret.lastSignal'))}</span><span class="v" data-f="age">–</span><span class="u" data-f="ageNote"></span></div>
        <div style="display:flex;flex-direction:column;gap:8px"><button class="btn" type="button" data-act="copy">${esc(t('ret.copyPos'))}</button><button class="btn" type="button" data-act="chat">${esc(t('ret.sendChat'))}</button><button class="btn" type="button" data-act="beep">${esc(t('ret.beep'))}</button></div>
      </aside>
    </div></main>`);
  root.replaceChildren(el);
  const over = createMap(qs(el, '.mapbox:not(.sat)'), { center: [p.start.lat, p.start.lon], zoom: 12 });
  const sat = createMap(qs(el, '.mapbox.sat'), { center: [p.start.lat, p.start.lon], zoom: 17, sat: true, follow: true });
  if (sat && typeof L !== 'undefined') L.control.scale({ imperial: false }).addTo(sat.map);
  if (over && p.result) { over.setStart(p.start.lat, p.start.lon, 'Start'); over.setLanding(p.result.landing.lat, p.result.landing.lon, `${t('plan.landingAt')} (${t('legend.plan')})`); }
  if (sat && p.result) sat.setLanding(p.result.landing.lat, p.result.landing.lon, `${t('plan.landingAt')} (${t('legend.plan')})`);
  let fitted = false;

  const render = () => {
    updateRetrieveStatus();
    const lp = landingPoint(), dev = state.device, box = qs(el, '.bannerbox');
    const f = (k) => qs(el, `[data-f=${k}]`);
    if (!lp) { box.innerHTML = banner({ level: 'bad', title: t('ret.banner.noPos'), sub: t('ret.banner.noPosSub') }); return; }
    const dist = dev ? distanceM(dev.lat, dev.lon, lp.lat, lp.lon) : null;
    const age = state.packets.lastT ? (now() - state.packets.lastT) / 1000 : null;
    const url = googleMapsNavUrl(lp.lat, lp.lon);
    const qr = `<div class="qr"><div class="box" id="qrbox"></div><div class="txt"><span style="font-size:14px;font-weight:600">${esc(t('ret.qr.title'))}</span><span style="font-size:13px;line-height:1.35">${esc(lp.estimated ? t('ret.qr.textEst') : t('ret.qr.text'))}</span><span style="font-size:12px;opacity:.8">${esc(lp.estimated ? t('ret.qr.replaced') : t('ret.qr.updates'))}</span></div></div>`;
    const navBtn = `<a class="btn primary big" href="${url}" target="_blank" rel="noopener" data-act="nav">${esc(lp.estimated ? t('ret.navEst') : t('ret.nav'))}</a>`;
    if (lp.estimated) {
      box.innerHTML = banner({ level: 'warn', title: t('ret.banner.lostTitle'), sub: t('ret.banner.lostSub', { time: fmtTimeUTC(lp.lastT), agl: fmtInt(lp.lastAgl), acc: fmtInt(lp.acc) }) + ` <strong>${esc(t('ret.banner.takeRx'))}</strong> ${esc(t('ret.banner.lostSub2'))}`, side: navBtn, extra: qr });
    } else {
      const last = state.last;
      box.innerHTML = banner({ level: 'ok', title: t('ret.banner.okTitle', { dist: dist !== null ? fmtNum(dist / 1000, 1) : '–' }), sub: t('ret.banner.okSub', { age: age !== null ? fmtDuration(age) : '–', h: last ? fmtNum((last.su - 3.4) * 6, 1) : '–' }), side: navBtn, extra: qr });
    }
    drawQr(qs(el, '#qrbox'), url);
    f('dist').textContent = dist !== null ? fmtNum(dist / 1000, 1) : '–';
    f('brg').textContent = dev ? fmtBearing(bearingDeg(dev.lat, dev.lon, lp.lat, lp.lon)) : '–';
    f('drive').textContent = dist !== null ? `≈ ${Math.max(1, Math.round((dist * 1.4) / 1000 / 40 * 60 + 2))}` : '–';
    f('pos').textContent = icaoSeconds(lp.lat, lp.lon);
    f('posNote').textContent = `${t('ret.posNote')} · ${lp.estimated ? t('ret.estimated', { m: fmtInt(lp.acc) }) : t('ret.accuracy', { m: lp.acc })}`;
    f('age').textContent = age !== null ? t('ret.ago', { d: fmtDuration(age) }) : '–';
    f('ageNote').textContent = age !== null && age > 120 ? t('ret.ageWeak') : t('ret.ageOk');
    const pt = { lat: lp.lat, lon: lp.lon };
    if (over) {
      over.setActual(state.launch ? state.telemetry.slice(state.launch.index) : state.telemetry);
      over.setSonde(lp.lat, lp.lon, `${t('ret.sonde')} · ${fmtTimeUTC(lp.t)}${lp.estimated ? ` (${t('ret.estimatedShort')})` : ''}`);
      if (dev) { over.setDevice(dev.lat, dev.lon, t('ret.me')); over.setConnector(dev, pt, `${fmtNum(dist / 1000, 1)} km · ${fmtBearing(bearingDeg(dev.lat, dev.lon, lp.lat, lp.lon))}`); }
      if (!fitted) { over.fitAll(); fitted = true; }
    }
    if (sat) sat.setSonde(lp.lat, lp.lon, `${t('ret.sonde')} · ${icaoSeconds(lp.lat, lp.lon)} · ±${fmtInt(lp.acc)} m`);
  };
  onAct(el, {
    copy: async () => { const lp = landingPoint(); if (!lp) return; const s = `${icaoSeconds(lp.lat, lp.lon)} · ${lp.lat.toFixed(6)}, ${lp.lon.toFixed(6)}`; toast((await copyText(s)) ? t('common.copied') : s); },
    chat: () => { const lp = landingPoint(); if (lp) ctx.sendChat(`${t('ret.chatPos')} ${icaoSeconds(lp.lat, lp.lon)} (${lp.lat.toFixed(5)}, ${lp.lon.toFixed(5)}) ${googleMapsNavUrl(lp.lat, lp.lon)}`); },
    beep: async () => { try { await state.link.setMode(5); await state.link.beep(); ctx.log('beep', ''); toast(t('ret.beepSent')); } catch (e) { toast(e.message, true); } },
  });
  el.addEventListener('click', (e) => { if (e.target.closest('[data-act=nav]')) ctx.log('navigate', 'Google Maps'); });   // onAct() would cancel the link's own navigation
  const offs = [bus.on('telemetry', render), bus.on('device', render), bus.on('landed', render)];
  const timer = setInterval(render, 5000);
  render();
  return { destroy() { offs.forEach((f) => f()); clearInterval(timer); if (over) over.destroy(); if (sat) sat.destroy(); el.remove(); }, expert: () => retrieveExpert(ctx) };
}
