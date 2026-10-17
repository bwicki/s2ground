// Phase 3 – "Start-Checks" (design/Checks.dc.html): eight automatic check items, the wire test
// button, the START box with "START FREIGEBEN" that only arms when everything is green.

import { t } from '../i18n.js';
import { esc, html, qs, onAct, banner, icons, toast } from '../util/dom.js';
import { state, bus, setPhaseStatus, now } from '../state.js';
import { fmtInt, fmtNum, fmtTimeUTC, fmtDuration, msToKt, windFromCourse, fmtBearing } from '../util/format.js';

const GPS_MIN_SATS = 5;

/** Compute the check list from the current state. Each item: {id, level, label, sub, act?}. */
export function computeChecks() {
  const ls = state.linkState, last = state.last, p = state.plan, tNow = now();
  const items = [];
  const age = state.packets.lastT ? (tNow - state.packets.lastT) / 1000 : null;
  const lossPct = state.packets.rx ? (state.packets.lost / (state.packets.rx + state.packets.lost)) * 100 : 0;
  items.push(ls.port !== 'open' ? { id: 'radio', level: 'bad', sub: t('chk.radio.noPort') }
    : age === null || age > 10 ? { id: 'radio', level: 'warn', sub: t('chk.radio.noPackets') }
      : lossPct > 10 ? { id: 'radio', level: 'warn', sub: t('chk.radio.lossy', { pct: fmtNum(lossPct, 0) }) }
        : { id: 'radio', level: 'ok', sub: t('chk.radio.ok') });
  const sats = last ? last.sats : (ls.sonde ? ls.sonde.sats : null);
  const fix = last && last.lat !== null && (sats ?? 0) >= GPS_MIN_SATS;
  items.push(fix ? { id: 'sondeGps', level: 'ok', sub: t('chk.gps.ok', { n: sats }) }
    : { id: 'sondeGps', level: 'warn', sub: t('chk.gps.waiting', { have: sats ?? 0, need: GPS_MIN_SATS }), since: state.checksSince ? fmtDuration((tNow - state.checksSince) / 1000) : '' });
  items.push(ls.receiver && ls.receiver.gnssFix ? { id: 'rxGps', level: 'ok', sub: t('chk.rxgps.ok') } : { id: 'rxGps', level: 'warn', sub: t('chk.rxgps.waiting') });
  const su = last ? last.su : (ls.sonde ? ls.sonde.batV : null);
  items.push(su === null || su === undefined ? { id: 'battery', level: 'warn', sub: t('chk.bat.unknown') }
    : su >= 3.95 ? { id: 'battery', level: 'ok', sub: t('chk.bat.ok', { h: fmtNum((su - 3.4) * 6, 1) }) }
      : su >= 3.75 ? { id: 'battery', level: 'warn', sub: t('chk.bat.low', { v: fmtNum(su, 2) }) } : { id: 'battery', level: 'bad', sub: t('chk.bat.bad', { v: fmtNum(su, 2) }) });
  const sensorsOk = last && last.te !== null && last.te > -40 && last.te < 50 && last.hu !== null && last.hu >= 0 && last.hu <= 100 && last.pa !== null && last.pa > 80000 && last.pa < 105000;
  items.push(sensorsOk ? { id: 'sensors', level: 'ok', sub: t('chk.sens.ok') } : { id: 'sensors', level: 'warn', sub: t('chk.sens.wait') });
  items.push(state.wireTest && state.wireTest.primaryOk ? { id: 'wire', level: 'ok', sub: t('chk.wire.ok', { led: state.wireTest.ledOk ? 'OK' : '–' }) }
    : state.wireTest ? { id: 'wire', level: 'bad', sub: t('chk.wire.failed') } : { id: 'wire', level: 'warn', sub: t('chk.wire.todo'), act: 'wire' });
  const w = state.sondeWritten;
  const wantCut = p.cutdownMode === 'alt' ? p.cutAltAgl : null;
  const settingsOk = w && (w.cutAltAgl === wantCut);
  items.push(settingsOk ? { id: 'settings', level: 'ok', sub: `${p.opMode === 'ascent' ? t('plan.opAscent') : t('plan.opDrop')} · ${wantCut === null ? t('plan.noCut') : `Cutdown ${fmtInt(wantCut)} m ${t('unit.agl')}`} · ${t('chk.set.confirmed')}`, act: 'settings' }
    : { id: 'settings', level: 'warn', sub: t('chk.set.mismatch'), act: 'settings' });
  items.push(state.relay.connected ? { id: 'observers', level: 'ok', sub: state.relay.presence.length ? t('chk.obs.ok', { names: state.relay.presence.map((u) => u.fullName || u.name).join(', ') }) : t('chk.obs.nobody') } : { id: 'observers', level: 'warn', sub: t('chk.obs.off') });
  return items;
}

export function updateChecksStatus() {
  const items = computeChecks();
  const open = items.filter((i) => i.level !== 'ok');
  const bad = items.some((i) => i.level === 'bad');
  if (!open.length) setPhaseStatus('checks', 'ok', t('chk.status.ok'));
  else setPhaseStatus('checks', bad ? 'bad' : 'warn', t('chk.status.open', { n: open.length, total: items.length }));
  return { items, open };
}

export function checksExpert() {
  const last = state.last, ls = state.linkState, rx = ls.receiver;
  const row = (k, v) => `<div class="row"><span class="muted">${esc(k)}</span><span class="val">${v}</span></div>`;
  const rate = state.packets.window ? state.packets.window : null;
  return {
    title: t('chk.expert.title'),
    body: row('RSSI / SNR', last && last.rs !== null ? `${fmtInt(last.rs)} dBm / ${fmtInt(last.snr)} dB` : '–')
      + row(t('chk.expert.rate'), rate ? `${fmtNum(rate.pct, 0)} % · ${rate.got} / ${rate.expected}` : `${state.packets.rx} / ${state.packets.rx + state.packets.lost}`)
      + row(t('chk.expert.slotSync'), ls.sonde && ls.sonde.sats >= GPS_MIN_SATS ? 'OK' : t('chk.expert.waitGps'))
      + row(t('chk.expert.sondeGps'), last ? `${last.sats ?? '–'} Sat · ${last.lat !== null ? '3D' : t('chk.expert.noFix')}` : '–')
      + row('RR4 GPS', rx ? `${rx.sats ?? '–'} Sat · ${rx.gnssFix ? '3D' : t('chk.expert.noFix')}` : '–')
      + row(t('chk.expert.ephemeris'), state.ephemerisT ? `${t('chk.expert.sent')} ${fmtTimeUTC(state.ephemerisT)}` : `<a href="#" data-act="gnss">${esc(t('chk.expert.sendNow'))}</a>`)
      + row(t('chk.expert.battery'), last ? `${fmtNum(last.su, 2)} V` : '–')
      + row('T / RH / p', last ? `${fmtNum(last.te, 1)} °C · ${fmtNum(last.hu, 0)} % · ${fmtNum(last.pa / 100, 1)}` : '–')
      + row('p RR4', rx && rx.pa ? `${fmtNum(rx.pa / 100, 1)} hPa` : '–')
      + row('LED-Test', `<a href="#" data-act="wire">${esc(t('chk.expert.run'))}</a>`)
      + row(t('prep.expert.power'), ls.sonde ? `${ls.sonde.powerDbm} dBm` : '–')
      + row(t('chk.expert.raw'), `<a href="#" data-act="log">${esc(t('hdr.protocol'))}</a>`),
  };
}

export function mountChecks(root, ctx) {
  if (!state.checksSince) state.checksSince = now();
  const el = html(`<main class="page"><div class="bannerbox"></div>
    <div class="row-wrap">
      <section class="card" style="flex:999 1 560px;gap:2px"><h2 style="margin-bottom:6px">${esc(t('chk.title'))}</h2><div class="list"></div></section>
      <aside class="card" style="flex:1 1 320px;justify-content:space-between"><div style="display:flex;flex-direction:column;gap:14px"><h2>Start</h2><div class="startbox"></div><div class="muted" style="font-size:14px;line-height:1.5">${esc(t('chk.startHint'))}</div><div class="rows"></div></div>
        <div style="display:flex;flex-direction:column;gap:8px"><button class="btn big primary" type="button" data-act="release" style="min-height:76px;font-size:22px">${esc(t('chk.release'))}</button><div class="muted small" style="text-align:center" data-f="releaseNote"></div></div></aside>
    </div></main>`);
  root.replaceChildren(el);
  let wireBusy = false;

  const render = () => {
    const { items, open } = updateChecksStatus();
    const st = state.phaseStatus.checks;
    const steps = [];
    if (open.some((i) => i.id === 'sondeGps')) steps.push(`<strong>${esc(t('chk.step.gps1'))}</strong>${esc(t('chk.step.gps2'))}`);
    if (open.some((i) => i.id === 'wire')) steps.push(`<strong>${esc(t('chk.step.wire1'))}</strong>${esc(t('chk.step.wire2'))}`);
    if (open.some((i) => i.id === 'radio')) steps.push(esc(t('chk.step.radio')));
    if (open.some((i) => i.id === 'settings')) steps.push(esc(t('chk.step.settings')));
    if (open.some((i) => i.id === 'battery')) steps.push(esc(t('chk.step.battery')));
    qs(el, '.bannerbox').innerHTML = open.length
      ? banner({ level: st.level, title: t('chk.banner.open', { n: open.length, total: items.length }), intro: steps.length ? t('chk.banner.todo') : '', steps })
      : banner({ level: 'ok', title: t('chk.banner.ok'), sub: t('chk.banner.okSub') });
    qs(el, '.list').innerHTML = items.map((i) => `<div class="ck"><span class="big ${i.level}">${i.level === 'ok' ? '✓' : i.level === 'bad' ? '!' : i.id === 'sondeGps' || i.id === 'sensors' ? '…' : '!'}</span>
      <div><div class="lbl">${esc(t(`chk.item.${i.id}`))}</div><div class="${i.level === 'ok' ? 'sub' : 'todo'}">${i.sub}</div></div>
      ${i.act === 'wire' ? `<button class="btn" type="button" data-act="wire" ${wireBusy ? 'disabled' : ''}>${esc(wireBusy ? t('chk.wire.running') : t('chk.wire.test'))}</button>` : i.act === 'settings' ? `<a href="#prepare" class="act">${esc(t('common.change'))}</a>` : i.since ? `<span class="muted small act">${esc(t('common.since'))} ${i.since}</span>` : '<span></span>'}</div>`).join('');
    const ready = !open.length;
    const sd = state.linkState.sonde;
    qs(el, '.startbox').className = `startbox ${ready ? 'ok' : ''}`;
    qs(el, '.startbox').innerHTML = `${icons.clock}<div><div class="t">${esc(ready ? t('chk.ready') : t('chk.wait'))}</div><div class="muted small">${esc(ready ? t('chk.readyLed') : t('chk.waitLed'))}</div></div>`;
    const last = state.last;
    const wind = last && last.spd !== null && last.spd >= 0.5 ? `${fmtBearing(windFromCourse(last.ang))} · ${fmtInt(msToKt(last.spd))} kt` : t('chk.calm');
    qs(el, '.rows').innerHTML = `<div class="row"><span class="muted">${esc(t('chk.plannedStart'))}</span><span class="val">${state.plan.result ? `${fmtTimeUTC(state.plan.result.launchMs)} UTC` : '–'}</span></div>
      <div class="row"><span class="muted">${esc(t('chk.groundWind'))}</span><span class="val">${wind}</span></div>
      <div class="row"><span class="muted">${esc(t('chk.observersN'))}</span><span class="val">${state.relay.presence.length}</span></div>
      <div class="row"><span class="muted">${esc(t('chk.sondeMode'))}</span><span class="val">${sd ? esc(ctx.modeText(sd.md).split(' · ')[0]) : '–'}</span></div>`;
    const btn = qs(el, '[data-act=release]'); btn.disabled = !ready || state.released;
    btn.className = `btn big ${ready ? 'primary' : 'disabled'}`;
    qs(el, '[data-f=releaseNote]').textContent = state.released ? t('chk.released') : ready ? t('chk.releaseReady') : t('chk.releaseNote', { n: items.length });
  };
  onAct(el, {
    wire: async () => {
      if (wireBusy) return; wireBusy = true; render();
      try { state.wireTest = await state.link.ledAndWireTest(); ctx.log('wireTest', JSON.stringify({ ...state.wireTest, raw: undefined })); toast(state.wireTest.primaryOk ? t('chk.wire.okToast') : t('chk.wire.failed'), !state.wireTest.primaryOk); }
      catch (e) { toast(`${t('chk.wire.error')}: ${e.message}`, true); }
      wireBusy = false; render();
    },
    release: () => ctx.release(),
  });
  const offs = [bus.on('telemetry', render), bus.on('linkstate', render), bus.on('presence', render), bus.on('relay', render), bus.on('written', render)];
  const timer = setInterval(render, 5000);
  render();
  return { destroy() { offs.forEach((f) => f()); clearInterval(timer); el.remove(); }, expert: () => ({ ...checksExpert(), bind: (panel) => onAct(panel, { wire: () => qs(el, '[data-act=wire]') && qs(el, '[data-act=wire]').click(), log: () => ctx.showLog(), gnss: () => ctx.gnssAid() }) }) };
}
