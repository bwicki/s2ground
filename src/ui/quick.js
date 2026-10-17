// Schnellstart «Sonde sofort hier starten» (design/Schnellstart.dc.html, docs/KONZEPT-Schnellstart.md):
// ONE page, three big steps – Verbinden · Einstellen · Starten – and one status box. Behind it run the same
// building blocks as the phase flow (link, planning for the airspace check, programSonde, wire test, checks, release,
// files, relay, log): the quick start only decides less and says more. Once the launch is detected the page turns
// into the live view (quick-live.js). The pure decisions live in ../quick.js.

import { t, tx } from '../i18n.js';
import { esc, html, qs, onAct, confirmDialog } from '../util/dom.js';
import { state, bus, settings, now } from '../state.js';
import { fmtInt, fmtNum, icaoSeconds, fmtDateISO, pad2 } from '../util/format.js';
import { runPlan } from './plan.js';
import { computeChecks, runWireTest } from './checks.js';
import { CUT_MIN, CUT_MAX, clampCut, stepCut, hereFrom, startMoved, startVerdict, sondeNr } from '../quick.js';
import { mountQuickLive } from './quick-live.js';

const DEFAULT_START = { ...state.plan.start };         // the app's default start, captured before any quick start touches the plan
const ICON = {
  wait: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  ok: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16.5 9.5"/></svg>',
  bad: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3L2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>',
};
const LEVEL_CLS = { wait: 'warn', go: 'ok', fail: 'bad' };

const newQuick = () => ({ run: 'idle', step: null, error: null, frozen: false, logged: false, armedAt: null, src: 'default', ignoreAir: false, checking: true, planError: null, checkedStart: null, checkedSrc: null, autoTried: false, inited: false });

/** `#quick`: the pre-start page until the launch is detected, then the live page. */
export function mountQuick(root, ctx) {
  if (!state.quick) state.quick = newQuick();
  const host = html('<div class="q-host"></div>');
  root.replaceChildren(host);
  let mode = null, child = null;
  const show = () => {
    const m = state.launch ? 'live' : 'pre';
    if (m === mode) return;
    if (child) child.destroy();
    const first = mode === null;
    mode = m;
    child = m === 'live' ? mountQuickLive(host, ctx) : mountPre(host, ctx, state.quick);
    if (!first) ctx.refreshHeader();
  };
  const off = bus.on('launch', show);
  show();
  return {
    destroy() { off(); if (child) child.destroy(); host.remove(); },
    subtitle: () => `${t('quick.subtitle')} · ${fmtDateISO(Date.now())}${state.linkState.sonde ? ` · ${t('quick.sonde', { nr: sondeNr(state.linkState.sonde.id) })}` : ''}`,
    header: () => (child ? child.header() : ''),
  };
}

function mountPre(host, ctx, q) {
  const p = state.plan;
  let destroyed = false, planTimer = null, running = null, again = false;
  // First visit in this ascent: operating mode «Aufstieg», cutdown from the planning if it was set there, else from the settings.
  if (!q.inited) {
    q.inited = true;
    p.cutAltAgl = clampCut(p.cutTouched ? p.cutAltAgl : (settings().cutAltAgl || p.cutAltAgl));
    Object.assign(p, { cutTouched: true, cutdownMode: 'alt', noCutdownConfirmed: false, opMode: 'ascent' });
  }

  const el = html(`<main class="page q-page">
    <div><h1>${esc(t('quick.title'))}</h1><div class="q-sub">${esc(t('quick.intro'))}</div></div>
    <section class="q-step"><div class="q-n">1</div><h2>${esc(t('quick.s1'))}</h2><div class="q-body" data-f="s1"></div></section>
    <section class="q-step"><div class="q-n">2</div><h2>${esc(t('quick.s2'))}</h2><div class="q-body">
      <div data-f="start"></div>
      <div class="q-cutrow"><span class="q-cutlabel">${esc(t('quick.cut.label'))}</span>
        <div class="q-stepper" role="group" aria-label="${esc(t('quick.cut.label'))}"><button type="button" data-act="cutMinus" aria-label="${esc(t('quick.cut.minus'))}">−&nbsp;500</button><div class="v"><span data-f="cut"></span><span class="q-u" style="font-size:16px">m AGL</span></div><button type="button" data-act="cutPlus" aria-label="${esc(t('quick.cut.plus'))}">+&nbsp;500</button></div>
        <span class="muted small" data-f="cutHint"></span></div>
      <div data-f="air"></div>
      <div class="muted small">${esc(t('quick.air.note'))}</div>
    </div></section>
    <section class="q-step"><div class="q-n">3</div><h2>${esc(t('quick.s3'))}</h2><div class="q-body">
      <button class="btn primary" type="button" data-act="go" style="min-height:76px;font-size:22px;letter-spacing:.02em">${esc(t('quick.go.btn'))}</button>
      <div class="muted small" data-f="goNote"></div>
      <div data-f="status" style="display:flex;flex-direction:column;gap:12px"></div>
      <div data-f="cancel"></div>
    </div></section>
    <div class="q-foot"><span>${esc(t('quick.foot'))}</span><div class="notify" data-f="notify"></div></div>
  </main>`);
  host.replaceChildren(el);
  const f = (k) => qs(el, `[data-f=${k}]`);
  const setHtml = (node, h) => { if (node.__h !== h) { node.__h = h; node.innerHTML = h; } };
  const line = (cls, ic, body, extra = '') => `<div class="q-line"><span class="q-ic ${cls}">${ic}</span><span>${body}</span>${extra}</div>`;
  const help = (text, cls = '') => `<div class="q-help ${cls}">${esc(text)}</div>`;
  const here = () => `<strong>${esc(t('quick.here'))}</strong>`;
  const curMd = () => (state.last ? state.last.md : (state.linkState.sonde ? state.linkState.sonde.md : null));
  const locked = () => q.run === 'working' || q.run === 'waiting' || state.released;

  // ---- step 1: Verbinden --------------------------------------------------------------------------------
  const paintS1 = () => {
    const ls = state.linkState, sd = ls.sonde, label = esc(t('quick.rx.label'));
    let out;
    if (ls.port === 'open') out = line('g', '✓', `${label}<strong>${esc(t('quick.rx.connected'))}</strong>`);
    else if (ls.port === 'opening') out = line('y', '…', `${label}<strong>${esc(t('quick.rx.connecting'))}</strong>`);
    else {
      const can = ctx.serialSupported || state.sim;
      out = line('r', '✗', `${label}<strong>${esc(t('quick.rx.missing'))}</strong>`, can ? `<button class="btn primary" type="button" data-act="connect">${esc(t('prep.rx.connect'))}</button>` : '') + help(can ? t('prep.rx.howTo') : t('prep.rx.noSerial'), 'r');
    }
    if (sd) {
      const v = state.last && state.last.su !== null && state.last.su !== undefined ? state.last.su : sd.batV;
      const lvl = v === null || v === undefined || v >= 3.95 ? 'g' : v >= 3.75 ? 'y' : 'r';
      out += line(lvl, lvl === 'g' ? '✓' : lvl === 'y' ? '!' : '✗', `${esc(t('quick.sd.found'))}<strong>${esc(t('quick.sd.nr'))} <span class="mono">${esc(sondeNr(sd.id))}</span></strong>${v === null || v === undefined ? '' : `, ${esc(t('quick.sd.bat', { v: fmtNum(v, lvl === 'g' ? 1 : 2) }))}`}`);
      if (lvl !== 'g') out += help(t('quick.sd.batLow'), lvl === 'r' ? 'r' : '');
    } else if (ls.port === 'open') out += line('y', '…', esc(t('quick.sd.missing'))) + help(t('prep.sd.howTo'));
    else out += line('x', '·', esc(t('quick.sd.waiting')));
    setHtml(f('s1'), out);
  };

  // ---- step 2: Einstellen (start = here, cutdown stepper, airspace check) ---------------------------------------
  const paintStart = () => {
    const s = p.start;
    const pos = `<span class="q-val">${esc(icaoSeconds(s.lat, s.lon))}</span> · <span class="q-val">${esc(fmtInt(s.alt))}</span> <span class="q-u">m AMSL</span>`;
    const out = q.src === 'rx' ? line('g', '✓', `${t('quick.start.rx', { here: here() })} ${pos}`)
      : q.src === 'device' ? line('y', '!', `${t('quick.start.device', { here: here() })} ${pos}`) + help(t('quick.start.fix'))
        : line('y', '!', `${tx('quick.start.default', { name: s.name || '–' })} ${pos}`) + help(t('quick.start.fix'));
    setHtml(f('start'), out);
  };
  const paintCut = () => {
    f('cut').textContent = fmtInt(p.cutAltAgl);
    const def = clampCut(settings().cutAltAgl);
    f('cutHint').textContent = p.cutAltAgl === def ? t('quick.cut.hint') : t('quick.cut.hintChanged', { def: fmtInt(def) });
    qs(el, '[data-act=cutMinus]').disabled = locked() || p.cutAltAgl <= CUT_MIN;
    qs(el, '[data-act=cutPlus]').disabled = locked() || p.cutAltAgl >= CUT_MAX;
  };
  const paintAir = () => {
    const r = p.result;
    let out;
    if (q.checking || (!r && !q.planError)) out = line('x', '…', esc(t('quick.air.checking')));
    else if (!r) out = line('y', '!', esc(t('quick.air.unchecked'))) + help(t('quick.air.failed')) + `<div><button class="btn" type="button" data-act="retryAir">${esc(t('plan.airspace.retry'))}</button></div>`;
    else if (r.conflicts.length && p.ignoreAirspace) out = line('y', '!', esc(tx('quick.air.ignored', { name: r.conflicts[0].airspace.name })));
    else if (r.conflicts.length) {
      const c = r.conflicts[0], sug = r.suggestAgl;
      const canLower = sug && sug >= CUT_MIN && sug < p.cutAltAgl;
      out = line('y', '!', tx(canLower ? 'quick.air.conflict' : 'quick.air.conflictNoFix', { name: c.airspace.name, alt: fmtInt(c.altEnter), cut: fmtInt(sug) }),
        canLower ? `<button class="btn" type="button" data-act="applySuggest" ${locked() ? 'disabled' : ''}>${esc(t('quick.air.lower', { cut: fmtInt(sug) }))}</button>` : '');
    } else if (p.showAirspace && r.airspaceError) {
      const why = r.airspaceError === 'E_NO_OPENAIP_KEY' ? t('plan.airspace.noKey') : r.airspaceError === 'E_OPENAIP_KEY_REJECTED' ? t('plan.airspace.badKey') : t('plan.airspace.unreachable');
      out = line('y', '!', esc(t('quick.air.unchecked'))) + help(why) + `<div><button class="btn" type="button" data-act="retryAir">${esc(t('plan.airspace.retry'))}</button></div>`;
    } else {
      const wind = p.windSource === 'open-meteo' ? 'Open-Meteo' : p.windSource === 'sim' ? t('plan.srcSim') : t('plan.srcFallback');
      out = line('g', '✓', `${tx('quick.air.ok', { src: { html: tx('quick.air.src', { wind }) } })} <strong>${esc(t('quick.air.okRes', { alt: fmtInt(p.cutAltAgl) }))}</strong>`);
    }
    setHtml(f('air'), out);
  };

  // ---- airspace check = the planning pipeline with start = here, launch = now, cutdown from the stepper -------------
  function prepPlan() {
    const d = new Date();
    Object.assign(p, { cutdownMode: 'alt', noCutdownConfirmed: false, opMode: 'ascent', cutTouched: true, tz: 'LT', date: fmtDateISO(d.getTime()), time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`, ignoreAirspace: q.ignoreAir });
    q.checkedStart = { lat: p.start.lat, lon: p.start.lon, alt: p.start.alt }; q.checkedSrc = q.src;
  }
  /** One run at a time; a request that arrives meanwhile makes it run once more with the latest values (no stale result wins). */
  function runCheck() {
    if (running) { again = true; return running; }
    running = (async () => {
      try { do { again = false; prepPlan(); try { await runPlan(); q.planError = null; } catch (e) { q.planError = e.message || 'E_PLAN'; } } while (again); }
      finally { running = null; q.checking = planTimer !== null; if (!destroyed) paintAir(); }
    })();
    return running;
  }
  const checkNow = () => { clearTimeout(planTimer); planTimer = null; return runCheck(); };
  function schedulePlan(delay = 450) {
    q.checking = true; paintAir();
    clearTimeout(planTimer); planTimer = setTimeout(() => { planTimer = null; runCheck(); }, delay);
  }
  /** Start = here: receiver GPS → device GPS → default start. Frozen once the start sequence has begun. */
  function applyHere(force = false) {
    if (q.frozen && !force) return;
    if (state.sim && !state.link) return;              // simulation: the simulated receiver (created at connect, at the plan's start) is the only GPS
    const h = hereFrom({ receiver: state.linkState.receiver, device: state.device, sondeRec: state.last, fallback: DEFAULT_START });
    const moved = startMoved(q.checkedStart, h, q.checkedSrc, h.source);
    p.start = { lat: h.lat, lon: h.lon, alt: h.alt, name: h.source === 'default' ? DEFAULT_START.name : '', source: h.source === 'rx' ? 'rr4' : 'map' };
    q.src = h.source;
    paintStart();
    if (moved) { q.ignoreAir = false; schedulePlan(q.checkedStart ? 450 : 50); }
  }

  // ---- step 3: Starten --------------------------------------------------------------------------------------
  const statusHtml = (v) => {
    const cls = LEVEL_CLS[v.level], key = `quick.st.${v.code}`;
    const ls = state.linkState, last = state.last;
    const su = last && last.su !== null ? last.su : (ls.sonde ? ls.sonde.batV : null);
    const params = { msg: v.msg || '', have: (last ? last.sats : (ls.sonde ? ls.sonde.sats : 0)) ?? 0, need: 5, v: fmtNum(su, 2), cut: fmtInt(p.cutAltAgl) };
    return `<div class="q-status ${cls}" role="status">${ICON[v.level === 'go' ? 'ok' : v.level === 'fail' ? 'bad' : 'wait']}<div><div class="big">${tx(`${key}.t`, params)}</div><div class="sub">${tx(`${key}.s`, params)}</div></div></div>`;
  };
  const paintGo = () => {
    const ls = state.linkState, sdOk = ls.port === 'open' && !!ls.sonde, busy = q.run === 'working';
    const verdict = q.run === 'idle' ? null : startVerdict(computeChecks(), { md: curMd(), working: busy ? q.step : null, error: q.run === 'failed' ? q.error : null });
    qs(el, '[data-act=go]').disabled = !(sdOk && !busy && !state.released && (q.run !== 'waiting' || verdict.level === 'fail'));
    setHtml(f('goNote'), esc(sdOk ? t('quick.go.note') : t('quick.go.needSonde')));
    let out = verdict ? statusHtml(verdict) : '';
    if (verdict && verdict.level === 'go' && state.released && !state.launch && q.armedAt && now() - q.armedAt > 60000) {
      out += `<div class="q-status warn" role="status">${ICON.wait}<div><div class="big">${esc(t('quick.st.stalled.t'))}</div><div class="sub">${esc(t('quick.st.stalled.s'))}</div></div></div>`;
    }
    setHtml(f('status'), out);
    setHtml(f('cancel'), q.run === 'waiting' && !state.released ? `<button class="btn" type="button" data-act="cancel">${esc(t('quick.go.cancel'))}</button>` : '');
    return verdict;
  };
  const paintNotify = () => {
    const list = (state.ascent && state.ascent.notify) || [];
    setHtml(f('notify'), !state.ascent ? `<span>${esc(t('quick.notify.later'))}</span>`
      : list.map((n) => (n.sent ? `<span style="color:var(--green)">✓ ${esc(tx('quick.notify.done', { label: n.label }))}</span>`
        : `<a href="${esc(n.waUrl)}" target="_blank" rel="noopener" data-act="notify" data-id="${n.observerId}" data-label="${esc(n.label)}">${tx('quick.notify.link', { label: n.label })}</a>`)).join(''));
  };
  const paint = () => { paintS1(); paintStart(); paintCut(); paintAir(); paintGo(); paintNotify(); };

  /** Re-check everything; as soon as the verdict is green the start is released by itself (same as «START FREIGEBEN»). */
  function evaluate() {
    if (destroyed) return;
    const v = paintGo();
    if (v && v.level === 'go' && q.run === 'waiting' && !state.released) { q.armedAt = now(); ctx.release({ stay: true }); }
    paintS1(); paintCut(); paintNotify();
  }
  const failure = (kind, msg = '') => Object.assign(new Error(msg || kind), { kind, msg });
  async function start() {
    if (q.run === 'working' || state.released) return;
    Object.assign(q, { run: 'working', step: 'check', error: null, frozen: true });
    paint();
    try {
      applyHere(true);
      await checkNow();
      const r = p.result;
      if (r && r.conflicts.length && !p.ignoreAirspace) {
        const c = r.conflicts[0];
        const ok = await confirmDialog({ title: t('quick.go.airTitle'), text: `<p>${tx('quick.go.airText', { name: c.airspace.name, alt: fmtInt(c.altEnter) })}</p>`, okLabel: t('quick.go.airOk'), cancelLabel: t('quick.go.airBack') });
        if (!ok) { Object.assign(q, { run: 'idle', step: null, frozen: false }); paint(); return; }
        q.ignoreAir = true; p.ignoreAirspace = true;
        ctx.log('plan.airspaceIgnored', r.conflicts.map((x) => x.airspace.id).join(', '));
      }
      if (!q.logged) {
        q.logged = true;
        const air = r && r.conflicts.length ? 'Luftraumkonflikt ignoriert' : !r || r.airspaceError ? 'Luftraum nicht geprüft' : 'Luftraum frei';
        ctx.log('quickstart', `Cutdown ${fmtInt(p.cutAltAgl)} m AGL · Start ${icaoSeconds(p.start.lat, p.start.lon)} (${q.src}) · ${fmtInt(p.start.alt)} m AMSL · Sonde ${state.linkState.sonde ? state.linkState.sonde.id : '–'} · ${air}`);
      }
      await ctx.ensureAscent();                         // the Worker session (and the observer messages) now carry the final start and cutdown
      q.step = 'program'; paint();
      state.wireTest = null; state.sondeWritten = null; state.checksSince = now();
      if (!(await ctx.programSonde(true))) throw failure('programFailed');
      q.step = 'wire'; paint();
      const wt = await runWireTest(ctx);
      if (!wt) throw failure('wireError');
      if (!wt.primaryOk) throw failure('wireBad');
      q.run = 'waiting';
    } catch (e) { q.run = 'failed'; q.error = e.kind ? e : failure('programFailed', e.message); }
    q.step = null;
    paint(); evaluate();
  }

  // ---- wiring ---------------------------------------------------------------------------------------------------
  onAct(el, {
    connect: () => ctx.connect(false, { deferAscent: true }),
    cutMinus: () => { if (!locked()) { p.cutAltAgl = stepCut(p.cutAltAgl, -1); q.ignoreAir = false; paintCut(); schedulePlan(); } },
    cutPlus: () => { if (!locked()) { p.cutAltAgl = stepCut(p.cutAltAgl, 1); q.ignoreAir = false; paintCut(); schedulePlan(); } },
    applySuggest: () => {
      const r = p.result;
      if (!r || !r.suggestAgl || locked()) return;
      p.cutAltAgl = clampCut(r.suggestAgl); q.ignoreAir = false;
      ctx.log('plan.suggestApplied', `Cutdown ${fmtInt(p.cutAltAgl)} m AGL`);
      paintCut(); schedulePlan(50);
    },
    retryAir: () => { q.checking = true; paintAir(); checkNow(); },
    go: () => start(),
    cancel: () => { Object.assign(q, { run: 'idle', step: null, error: null, frozen: false }); state.sondeWritten = null; state.wireTest = null; paint(); },
  });
  el.addEventListener('click', (e) => {                // the wa.me link keeps its default (opens WhatsApp); we only remember the tap
    const a = e.target.closest('[data-act=notify]');
    if (a) ctx.markNotified(Number(a.dataset.id), a.dataset.label);
  });
  const offs = [bus.on('linkstate', () => { applyHere(); evaluate(); }), bus.on('telemetry', evaluate), bus.on('written', evaluate), bus.on('relay', paintNotify), bus.on('plan', paintAir), bus.on('device', () => applyHere())];
  const timer = setInterval(() => { applyHere(); evaluate(); }, 2000);

  paint(); applyHere(); evaluate();
  // Step 1 connects by itself when that needs no click: the simulation, or a USB port the browser remembers. Otherwise «Verbinden».
  if (!q.autoTried && state.linkState.port === 'closed') {
    q.autoTried = true;
    (async () => {
      let can = state.sim;
      if (!can && navigator.serial && navigator.serial.getPorts) { try { can = (await navigator.serial.getPorts()).length > 0; } catch { can = false; } }
      if (can && !destroyed && state.linkState.port === 'closed') ctx.connect(false, { deferAscent: true });
    })();
  }
  return {
    destroy() { destroyed = true; clearTimeout(planTimer); clearInterval(timer); offs.forEach((o) => o()); el.remove(); },
    header: () => `<span class="pill amber">${esc(t('quick.pill'))}</span><a href="#plan">${esc(t('quick.toPlan'))}</a>`,
  };
}
