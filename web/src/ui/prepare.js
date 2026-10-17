// Phase 2 – "Sonde vorbereiten" (design/Vorbereiten.dc.html): receiver, sonde, balloon and
// observer cards, the values written to the sonde, expert menu with radio/port/relay/folder.

import { t } from '../i18n.js';
import { esc, html, qs, onAct, banner, icons, toast, copyText } from '../util/dom.js';
import { state, bus, setPhaseStatus, settings } from '../state.js';
import { fmtInt, fmtNum, fmtTimeUTC, qnhFromStation } from '../util/format.js';

const okline = (level, title, sub) => `<div class="okline"><span class="big ${level}">${level === 'ok' ? '✓' : level === 'warn' ? '…' : level === 'bad' ? '!' : '·'}</span><div><div style="font-weight:600">${title}</div><div class="muted small">${sub}</div></div></div>`;

/** Phase status derived from link + confirmations; also called by app.js on link events. */
export function updatePrepareStatus() {
  const ls = state.linkState;
  const problems = [];
  if (ls.port !== 'open') problems.push(t('prep.p.receiver'));
  if (!ls.sonde) problems.push(t('prep.p.sonde'));
  if (!state.balloonConfirmed) problems.push(t('prep.p.balloon'));
  if (ls.sonde && !state.sondeWritten) problems.push(t('prep.p.written'));
  if (!problems.length) setPhaseStatus('prepare', 'ok', t('prep.status.ok'));
  else setPhaseStatus('prepare', ls.port !== 'open' ? 'bad' : 'warn', t('prep.status.open', { list: problems.join(', ') }));
  return problems;
}

export function prepareExpert(ctx) {
  const p = state.plan, ls = state.linkState, s = settings(), master = state.session && state.session.role === 'master';
  const net = ls.net || {};
  const lockedAttr = master ? '' : 'readonly';
  return {
    title: t('prep.expert.title'), cls: 'form',
    body: `<div class="sec"><div class="k">${esc(t('prep.expert.sonde'))}</div>
        <label class="f">${esc(t('plan.opMode'))}<div class="seg"><button type="button" class="${p.opMode === 'ascent' ? 'on' : ''}" data-act="op" data-m="ascent">${esc(t('phase.ascent'))}</button><button type="button" class="${p.opMode === 'drop' ? 'on' : ''}" data-act="op" data-m="drop">${esc(t('prep.expert.drop'))}</button></div><span class="hint">${esc(t('prep.expert.dropHint'))}</span></label>
        <label class="f">${esc(t('prep.expert.cutAlt'))}<input class="in mono" name="cutAltAgl" type="number" step="100" value="${p.cutAltAgl}" ${p.cutdownMode === 'none' ? 'disabled' : ''}></label>
        <label class="chk"><input type="checkbox" name="noCut" ${p.cutdownMode === 'none' ? 'checked' : ''}> ${esc(t('prep.expert.noCut'))}</label>
        <label class="chk"><input type="checkbox" name="groundInPressure" checked> ${esc(t('prep.expert.groundPressure'))}</label>
      </div>
      <div class="sec"><div class="k" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${esc(t('prep.expert.radio'))} <span class="lock">${icons.lock}${esc(t('prep.expert.masterOnly'))}</span></div>
        <div class="muted" style="font-size:12px;margin-top:-4px">${esc(t('prep.expert.radioNote'))}</div>
        <label class="f">${esc(t('prep.expert.frequency'))}<input class="in mono" name="frequencyHz" type="text" value="${net.frequencyHz ? fmtNum(net.frequencyHz / 1e6, 3) : fmtNum(s.frequencyHz / 1e6, 3)} MHz" ${lockedAttr}></label>
        <label class="f">${esc(t('prep.expert.power'))}<input class="in mono" type="text" value="${ls.sonde ? `${ls.sonde.powerDbm} dBm / ${ls.sonde.powerBeforeLaunchDbm} dBm` : '–'}" readonly></label>
        <label class="f">${esc(t('prep.expert.lora'))}<input class="in mono" type="text" value="${net.sf ? `SF ${net.sf} · ${net.bw / 1000} kHz · 4/${net.cr}` : '–'}" readonly></label>
        <label class="f">${esc(t('prep.expert.slots'))}<input class="in mono" name="timeslots" type="text" value="${net.timeslots ?? '–'}" ${lockedAttr}></label>
      </div>
      <div class="sec"><div class="k">${esc(t('prep.expert.port'))}</div>
        <div class="row"><span class="muted">Port</span><span class="val">${ls.port === 'open' ? (state.sim ? 'SIM' : 'Web Serial · 38\'400 Bd') : t('prep.expert.closed')}</span></div>
        <div class="row"><span class="muted">RR4 Firmware</span><span class="val">${ls.receiver ? `${esc(ls.receiver.fw)} · prot ${esc(ls.receiver.prot)}` : '–'}</span></div>
        <div class="row"><span class="muted">S2 Firmware</span><span class="val">${ls.sonde ? esc(ls.sonde.fwver ?? '–') : '–'}</span></div>
        <div class="row"><span class="muted">${esc(t('prep.expert.sondeState'))}</span><span class="val">${ls.sonde ? esc(modeText(ls.sonde.md)) : '–'}</span></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" data-act="reconnect">${esc(t('prep.expert.otherPort'))}</button><button class="btn" type="button" data-act="log">${esc(t('hdr.protocol'))}</button></div>
      </div>
      <div class="full sep menu-grid3">
        <div class="sec"><div class="k">${esc(t('prep.expert.relay'))}</div>
          <div class="row"><span class="muted">Relay</span><span class="val" style="color:${state.relay.connected ? 'var(--green)' : 'var(--amber)'}">${state.relay.connected ? t('prep.expert.relayOk', { n: state.relay.errors }) : t('prep.expert.relayOff')}</span></div>
          <div class="row"><span class="muted">${esc(t('prep.expert.followCode'))}</span><span class="val">${state.ascent ? esc(state.ascent.followCode) : '–'}</span></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" data-act="copyCode">${esc(t('common.copy'))}</button><button class="btn" type="button" data-act="newCode">${esc(t('prep.expert.newCode'))}</button><button class="btn" type="button" data-act="guestLink">${esc(t('prep.expert.guestLink'))}</button></div>
        </div>
        <div class="sec"><div class="k">${esc(t('prep.expert.storage'))}</div>
          <label class="f">${esc(t('prep.expert.folder'))}<input class="in mono" type="text" value="${esc(state.files.folder || s.defaultFolder || '')}" readonly></label>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" data-act="chooseFolder" ${state.files.supported ? '' : 'disabled'}>${esc(t('prep.expert.chooseFolder'))}</button><button class="btn" type="button" data-act="downloads">${esc(t('prep.expert.downloads'))}</button></div>
          <span class="muted" style="font-size:12px">${esc(t('prep.expert.storageNote'))}</span>
        </div>
        <div class="muted" style="font-size:13px;align-self:end">${esc(t('prep.expert.observersNote'))}</div>
      </div>
      <div class="full sep" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><button class="btn primary" type="button" data-act="program">${esc(t('prep.expert.program'))}</button><span class="muted small">${esc(t('prep.expert.programNote'))}</span></div>`,
    bind(panel) {
      panel.addEventListener('change', (e) => {
        const n = e.target.name;
        if (n === 'cutAltAgl') { p.cutAltAgl = Math.round(Number(e.target.value) / 100) * 100; state.sondeWritten = null; updatePrepareStatus(); }
        if (n === 'noCut') { p.cutdownMode = e.target.checked ? 'none' : 'alt'; p.noCutdownConfirmed = e.target.checked; state.sondeWritten = null; panel.querySelector('[name=cutAltAgl]').disabled = e.target.checked; updatePrepareStatus(); }
      });
      onAct(panel, {
        op: (b) => { p.opMode = b.dataset.m; panel.querySelectorAll('[data-act=op]').forEach((x) => x.classList.toggle('on', x === b)); },
        reconnect: () => ctx.connect(true),
        log: () => ctx.showLog(),
        copyCode: async () => { if (state.ascent) toast((await copyText(state.ascent.followCode)) ? t('common.copied') : state.ascent.followCode); },
        newCode: () => ctx.newAscent(),
        guestLink: async () => { if (!state.ascent) return; const u = `https://s2stueve.wicki.aero/#follow/${state.ascent.followCode}`; toast((await copyText(u)) ? t('common.copied') : u); },
        chooseFolder: () => ctx.chooseFolder(),
        downloads: () => ctx.downloadFiles(),
        program: () => ctx.programSonde(true),
      });
    },
  };
}

export function modeText(md) {
  const k = { 0: 'mode.init', 1: 'mode.ready', 2: 'mode.rising', 3: 'mode.falling', 4: 'mode.resting', 5: 'mode.findme', 6: 'mode.findmeSlow', 7: 'mode.cutdown', A: 'mode.tooHigh' }[md];
  return k ? t(k) : String(md);
}

export function mountPrepare(root, ctx) {
  const el = html(`<main class="page"><div class="bannerbox"></div><div class="stats4 cards"></div><section class="card written"></section></main>`);
  root.replaceChildren(el);
  const p = state.plan;

  const render = () => {
    const ls = state.linkState, rx = ls.receiver, sd = ls.sonde;
    const problems = updatePrepareStatus();
    const st = state.phaseStatus.prepare;
    qs(el, '.bannerbox').innerHTML = problems.length
      ? banner({ level: st.level, title: t('prep.banner.openTitle', { n: problems.length }), intro: t('prep.banner.openIntro'), steps: problems.map(esc) })
      : banner({ level: 'ok', title: t('prep.banner.ok'), sub: t('prep.banner.okSub') });
    const lift = p.result ? p.result.lift : null;
    qs(el, '.cards').innerHTML = `
      <section class="card"><h2>${esc(t('prep.card.receiver'))}</h2>
        ${ls.port === 'open' ? okline('ok', t('prep.rx.connected', { how: state.sim ? 'Simulation' : 'USB' }), `${rx && rx.gnssFix ? 'GPS fix' : t('prep.rx.noFix')} · ${rx && rx.batV ? `${fmtNum(rx.batV, 2)} V` : ''} · ${ls.net ? `${fmtNum(ls.net.frequencyHz / 1e6, 3)} MHz` : ''}`)
          : okline(ls.port === 'opening' ? 'warn' : 'bad', t('prep.rx.notConnected'), t('prep.rx.howTo'))}
        ${ls.port === 'open' ? '' : `<button class="btn primary" type="button" data-act="connect" ${ls.port === 'opening' ? 'disabled' : ''}>${esc(t('prep.rx.connect'))}</button>`}
        ${ctx.serialSupported || state.sim ? '' : `<p class="muted small" style="margin:0">${esc(t('prep.rx.noSerial'))}</p>`}
      </section>
      <section class="card"><h2>${esc(t('prep.card.sonde'))}</h2>
        ${sd ? okline('ok', `${t('prep.sd.detected')} · ${t('prep.sd.number')} <span class="mono">${fmtInt(sd.id).replace("'", '')}</span>`, `${esc(sd.type || '–')} · ${sd.role === 1 ? t('prep.sd.reusable') : ''} · MAC <span class="mono">${esc(sd.id.toString(16).toUpperCase())}</span> · ${t('prep.sd.battery')} ${fmtNum(sd.batV, 2)} V · Firmware ${esc(sd.fwver ?? '–')}`)
          : okline(ls.port === 'open' ? 'warn' : 'todo', t('prep.sd.notDetected'), t('prep.sd.howTo'))}
      </section>
      <section class="card"><h2>${esc(t('prep.card.balloon'))}</h2>
        ${okline(state.balloonConfirmed ? 'ok' : 'warn', `${esc(p.balloonType)} · ${esc(p.gas)}`, t('prep.bl.fromPlan'))}
        <div><div class="row"><span class="muted">${esc(t('prep.bl.gross'))}</span><span class="val">${lift ? `≈ ${fmtInt(lift.grossLiftG)} g` : '–'}</span></div>
        <div class="row"><span class="muted">${esc(t('prep.bl.net', { g: p.payloadG }))}</span><span class="val">${lift ? `≈ ${fmtInt(lift.netLiftG)} g` : '–'}</span></div>
        <div class="row"><span class="muted">${esc(t('prep.bl.rise'))}</span><span class="val">${fmtNum(p.riseRate, 1)} m/s</span></div></div>
        <button class="btn ${state.balloonConfirmed ? 'okish' : 'warnish'}" type="button" data-act="balloon" style="text-align:left;line-height:1.3;justify-content:space-between"><span>${esc(t('prep.bl.ready', { g: lift ? fmtInt(lift.grossLiftG) : '–' }))}${state.balloonConfirmed ? '' : '?'}</span><span class="nowrap">${state.balloonConfirmed ? `✓ ${esc(t('prep.bl.confirmed'))}` : `→ ${esc(t('prep.bl.confirm'))}`}</span></button>
      </section>
      <section class="card"><h2>${esc(t('prep.card.observers'))}</h2>
        ${state.relay.connected ? okline('ok', t('prep.ob.connected'), t('prep.ob.visible')) : okline('warn', t('prep.ob.notConnected'), t('prep.ob.retrying'))}
        <div style="display:flex;flex-direction:column;gap:6px">${state.relay.presence.length ? state.relay.presence.map((u) => `<div class="obs"><span><span class="dot g" style="margin-right:8px"></span>${esc(u.fullName || u.name)} <span class="muted">(${esc(u.name)})</span></span><span class="muted small">${t('common.since')} ${fmtTimeUTC(u.since)} UTC</span></div>`).join('') : `<span class="muted small">${esc(t('prep.ob.nobody'))}</span>`}</div>
      </section>`;
    const w = state.sondeWritten;
    qs(el, '.written').innerHTML = `<h2>${esc(t('prep.written.title'))}</h2>
      <div class="stats4">
        <div><div class="k">${esc(t('plan.opMode'))}</div><div class="val">${esc(p.opMode === 'ascent' ? t('plan.opAscent') : t('plan.opDrop'))}</div></div>
        <div><div class="k">Cutdown</div><div class="val">${w ? (w.cutAltAgl === null ? t('plan.noCut') : `${fmtInt(w.cutAltAgl)} m AGL · ${fmtInt(w.cutAltAgl + p.start.alt)} m AMSL`) : '–'}</div></div>
        <div><div class="k">${esc(t('prep.expert.frequency'))}</div><div class="val">${ls.net ? `${fmtNum(ls.net.frequencyHz / 1e6, 3)} MHz` : '–'}</div></div>
        <div><div class="k">${esc(t('prep.written.groundPressure'))}</div><div class="val">${w ? `${fmtNum(w.groundPa / 100, 1)} hPa · ${fmtNum(qnhFromStation(w.groundPa, p.start.alt), 1)}` : '–'}</div></div>
      </div>
      <div class="muted small">${w ? esc(t('prep.written.readBack', { time: fmtTimeUTC(w.t, true) })) : esc(sd ? t('prep.written.pending') : t('prep.written.noSonde'))}</div>`;
  };
  onAct(el, {
    connect: () => ctx.connect(),
    balloon: () => { state.balloonConfirmed = !state.balloonConfirmed; ctx.log(state.balloonConfirmed ? 'balloon.confirmed' : 'balloon.unconfirmed', p.balloonType); render(); },
  });
  const offs = [bus.on('linkstate', render), bus.on('presence', render), bus.on('relay', render), bus.on('written', render), bus.on('plan', render)];
  render();
  if (state.linkState.port === 'closed' && state.sim) ctx.connect();
  return { destroy() { offs.forEach((f) => f()); el.remove(); }, expert: () => prepareExpert(ctx) };
}
