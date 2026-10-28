// S2 Ground – bootstrap, routing, session, link wiring, phase state machine and "Weiter" logic.
// Views live in ./ui/*.js; hardware access only through the GroundLink facade (./protocol or ./sim).

import { initI18n, setLang, onLangChange, t, currentLang } from './i18n.js';
import { api, SIM, DEFAULT_SETTINGS } from './api.js';
import { state, bus, PHASES, settings, addLine, resetAscent, now } from './state.js';
import { esc, html, qs, toast, confirmDialog } from './util/dom.js';
import { fmtInt, fmtDateISO, fmtTimeUTC } from './util/format.js';
import { Relay } from './relay.js';
import { FlightFiles } from './files.js';
import { renderHeader, renderActionBar, renderConfirmStrip, phaseLabel } from './ui/header.js';
import { mountLogin } from './ui/login.js';
import { mountPlan, runPlan, updatePlanStatus } from './ui/plan.js';
import { mountPrepare, updatePrepareStatus, modeText } from './ui/prepare.js';
import { mountChecks, updateChecksStatus } from './ui/checks.js';
import { mountAscent, updateAscentStatus } from './ui/ascent.js';
import { mountDetail } from './ui/detail.js';
import { mountRetrieve, updateRetrieveStatus } from './ui/retrieve.js';
import { mountAdmin } from './ui/admin.js';
import { mountQuick } from './ui/quick.js';
import { VERSION } from './version.js';

const params = new URLSearchParams(location.search);
const root = document.getElementById('app');
const slots = { sim: null, header: null, action: null, confirm: null, view: null };
let view = null, viewName = null, relay = null;
const files = new FlightFiles();
state.sim = SIM;

// ---- context handed to the views ------------------------------------------------------------
const ctx = {
  serialSupported: !!navigator.serial,
  log: (action, detail) => api.log.add(action, detail),
  modeText,
  /** opts.deferAscent: connect only – the quick start creates the ascent session once start and cutdown are final. */
  connect: (reselect = false, opts) => connectLink(reselect, opts),
  programSonde: (force = false) => programSonde(force),
  /** opts.stay: arm without leaving the current page (quick start). */
  release: (opts) => release(opts),
  newAscent: () => createAscent(true),
  ensureAscent: () => createAscent(false),
  archive: (to) => archive(to),
  refreshHeader: () => renderHeaderBar(),
  chooseFolder: async () => { try { const n = await files.chooseFolder(); state.files.folder = n; toast(t('files.folderSet', { name: n })); bus.emit('relay'); } catch { /* cancelled */ } },
  downloadFiles: () => { if (!files.base) { toast(t('files.noAscent'), true); return; } files.downloadAll({ landingEstimate: null }); },
  sendChat: (text) => { if (!relay) return; relay.sendChat(text, state.session.user, state.session.role); ctx.log('chat', text.slice(0, 120)); },
  showLog: () => showLog(),
  gnssAid: async () => { try { await state.link.gnssAidToSonde(); state.ephemerisT = Date.now(); toast(t('chk.expert.sent')); } catch (e) { toast(e.message, true); } },
  goto: (p) => gotoPhase(p),
  /** Ground user removes an observer from the running ascent (socket closed + blocked, see Worker live.js). */
  kick: async (observerId, name) => {
    if (!state.ascent || !relay) return;
    try { if (api.mock) relay.mockKick(observerId); else await api.ascents.kick(state.ascent.ascentId, observerId); ctx.log('observer.kicked', name || String(observerId)); toast(t('prep.ob.kicked', { name: name || '' })); }
    catch (e) { toast(e.message, true); }
  },
  /** Stage-1 WhatsApp: the wa.me button was tapped → remember + log it (the send itself happens in WhatsApp). */
  markNotified: (observerId, label) => {
    const n = state.ascent && state.ascent.notify && state.ascent.notify.find((x) => x.observerId === observerId);
    if (n && !n.sent) { n.sent = true; n.manual = true; ctx.log('notify.whatsapp', label || String(observerId)); bus.emit('relay'); }
  },
};

// ---- session ------------------------------------------------------------------------------
async function restoreSession() {
  if (!api.token) return false;
  try {
    const me = await api.me();
    state.session = { user: me.user, role: me.role, master: !!me.master, settings: { ...DEFAULT_SETTINGS, ...me.settings }, loginAt: Date.now(), lastActivity: Date.now() };
    return true;
  } catch { api.setToken(null); return false; }
}
async function login(user, password) {
  const r = await api.login(user, password);
  api.setToken(r.token);
  const me = await api.me();
  state.session = { user: me.user, role: me.role, master: !!me.master, settings: { ...DEFAULT_SETTINGS, ...me.settings }, loginAt: Date.now(), lastActivity: Date.now() };
  if (r.lang) await setLang(r.lang);
  location.hash = '#plan';                                   // the quick start is a button in step 1, never a way around the login
}
async function logout() {
  await api.logout(); api.setToken(null); state.session = null;
  if (state.link) { try { await state.link.disconnect(); } catch { /* ignore */ } }
  if (relay) relay.close();
  location.hash = '#login';
}
// Auto-logout after N hours without activity (settings.autoLogoutH, default 2 h)
['click', 'keydown', 'pointerdown'].forEach((ev) => document.addEventListener(ev, () => { if (state.session) state.session.lastActivity = Date.now(); }, { passive: true }));
setInterval(() => {
  if (!state.session) return;
  const h = settings().autoLogoutH || 2;
  if (Date.now() - state.session.lastActivity > h * 3600e3) { toast(t('session.autoLogout')); logout(); }
}, 60e3);

// ---- link (GroundLink / SimGroundLink) -------------------------------------------------------
async function createLink() {
  if (state.link) return state.link;
  let LinkClass = null;
  if (!SIM && navigator.serial) {
    try { const mod = await import('./protocol/index.js'); LinkClass = mod.GroundLink; } catch (e) { console.warn('protocol module missing → simulation', e); }
  }
  if (!LinkClass) {
    const mod = await import('./sim/sim-link.js');
    const speed = Number(params.get('speed')) || 1;
    LinkClass = class extends mod.SimGroundLink { constructor() { super({ speed, seed: Number(params.get('seed')) || 42, start: { ...state.plan.start }, cutAltAgl: state.plan.cutdownMode === 'alt' ? state.plan.cutAltAgl : null, lostSignal: params.get('lost') === '1', gpsFixS: params.get('fast') === '1' ? 3 : 25 }); } };
    state.sim = true;
  }
  const link = new LinkClass();
  link.addEventListener('state', (e) => { state.linkState = e.detail; bus.emit('linkstate', e.detail); });
  link.addEventListener('telemetry', (e) => onTelemetry(e.detail));
  link.addEventListener('packet', (e) => { state.packets.rs = e.detail.rs; state.packets.snr = e.detail.snr; });
  link.addEventListener('event', (e) => onLinkEvent(e.detail));
  link.addEventListener('line', (e) => { addLine(e.detail); if (e.detail.dir === 'tx') files.addComment(`EXE_NOW: ${e.detail.text}`, e.detail.t); });
  link.addEventListener('error', (e) => {
    const msg = e.detail && e.detail.message || '';
    // SSP join timeout is not fatal: the text channel keeps working (spec §1.6) – show it as a warning only.
    toast(`${t('link.error')}: ${msg}`, !msg.startsWith('E_SSP_JOIN_TIMEOUT'));
  });
  state.link = link;
  return link;
}
async function connectLink(reselect = false, { deferAscent = false } = {}) {
  const link = await createLink();
  try {
    state.linkState = { ...state.linkState, port: 'opening' }; bus.emit('linkstate', state.linkState);
    await link.connect(reselect ? {} : undefined);
    state.linkState = link.state; bus.emit('linkstate', state.linkState);
    ctx.log('link.connected', state.sim ? 'SIM' : `RR4 ${link.state.receiver ? link.state.receiver.fw : ''}`);
    // Learn the RR4's USB VID:PID once (admin page shows it; later used to pre-select the port). Master only – others lack the right.
    const usb = link.state.receiver && link.state.receiver.usb;
    if (!state.sim && usb && usb.usbVendorId && !settings().rr4Usb && state.session && state.session.master) {
      const id = `${usb.usbVendorId.toString(16).padStart(4, '0')}:${(usb.usbProductId || 0).toString(16).padStart(4, '0')}`.toUpperCase();
      try { Object.assign(settings(), await api.settings.put({ rr4Usb: id })); bus.emit('settings'); } catch (ex) { console.warn('rr4Usb not saved', ex); }
    }
    if (!deferAscent) await createAscent(false);
    pollLink();
  } catch (e) {
    state.linkState = { ...state.linkState, port: 'closed' }; bus.emit('linkstate', state.linkState);
    toast(`${t('link.connectFailed')}: ${e.message}`, true);
  }
}
/** The facade's state getter is a snapshot – poll it so sonde discovery shows up without a 'state' event. */
let pollTimer = null;
function pollLink() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!state.link) return;
    const s = state.link.state;
    const changed = JSON.stringify({ a: s.port, b: s.sonde && s.sonde.md, c: !!s.sonde, d: s.receiver && s.receiver.gnssFix }) !== JSON.stringify({ a: state.linkState.port, b: state.linkState.sonde && state.linkState.sonde.md, c: !!state.linkState.sonde, d: state.linkState.receiver && state.linkState.receiver.gnssFix });
    state.linkState = s;
    if (changed) bus.emit('linkstate', s);
    if (s.sonde && !state.sondeWritten && !programming && (state.phase === 'prepare' || state.phase === 'checks')) programSonde(false);
    if (state.phase === 'prepare') updatePrepareStatus();
    if (state.phase === 'checks') updateChecksStatus();
  }, 2000);
}
let programming = false;
/** Write the plan to the sonde (cutdown altitude) and read it back; start the telemetry session. Resolves true when written and read back. */
async function programSonde(force) {
  if (programming || !state.link || !state.linkState.sonde) return false;
  if (state.sondeWritten && !force) return false;
  programming = true;
  try {
    const p = state.plan;
    const groundPa = state.last && state.last.pa ? state.last.pa : (state.linkState.receiver && state.linkState.receiver.pa) || 96240;
    let cut = null;
    if (p.cutdownMode === 'alt') cut = await state.link.setCutdownAltitude(p.cutAltAgl, groundPa);
    const info = await state.link.readSonde();
    state.link.startSession({ groundAlt: p.start.alt, groundPa, meta: { name: state.ascent ? state.ascent.name : '' } });
    files.setGroundAlt(p.start.alt);
    state.sondeWritten = { cutAltAgl: p.cutdownMode === 'alt' ? (cut ?? p.cutAltAgl) : null, groundPa, t: Date.now(), sondeType: info && info.type };
    ctx.log('sonde.programmed', `${info ? info.type : ''} · ${p.opMode} · Cutdown ${state.sondeWritten.cutAltAgl ?? '–'} m AGL`);
    bus.emit('written', state.sondeWritten);
    programming = false;
    return true;
  } catch (e) { toast(`${t('prep.programFailed')}: ${e.message}`, true); }
  programming = false;
  return false;
}

// ---- telemetry processing (spec §6.2 simplified) ------------------------------------------
function onTelemetry(rec) {
  const prev = state.last;
  state.telemetry.push(rec); state.last = rec;
  state.packets.rx++; state.packets.lastT = rec.t;
  if (prev && rec.seq !== null && prev.seq !== null && rec.seq > prev.seq + 1) state.packets.lost += rec.seq - prev.seq - 1;
  const idx = state.telemetry.length - 1;
  // launch report: first record > 35 m AGL → the latest earlier record that was not ascending
  if (!state.launch && rec.altAgl !== null && rec.altAgl > 35) {
    let i = idx; while (i > 0 && (state.telemetry[i - 1].rise ?? 0) > 0.5 && (state.telemetry[i - 1].altAgl ?? 0) > 5) i--;
    state.launch = { index: i, t: state.telemetry[i].t, alt: state.telemetry[i].alt };
    files.setLaunchIndex(i);
    ctx.log('launch.detected', `${fmtTimeUTC(state.launch.t)} UTC · ${fmtInt(state.launch.alt)} m AMSL`);
    bus.emit('launch', state.launch);
  }
  if (state.launch && (!state.peak || rec.alt > state.peak.alt)) state.peak = { alt: rec.alt, t: rec.t };
  if (state.launch && !state.cutdown && (rec.md === 7 || (rec.md === 3 && prev && prev.md === 2))) state.cutdown = { t: rec.t, alt: rec.alt, altAgl: rec.altAgl, by: 'auto' };
  // landed: sonde says resting/find-me, or 100 m below peak with |rise| < 1 for > 30 s
  if (state.launch && !state.landed) {
    const resting = rec.md === 4 || rec.md === 5 || rec.md === 6;
    const low = state.peak && rec.alt < state.peak.alt - 100 && Math.abs(rec.rise ?? 0) < 1;
    if (low) state.lowSince = state.lowSince || rec.t; else state.lowSince = null;
    if (resting || (state.lowSince && rec.t - state.lowSince > 30000)) {
      state.landed = { t: rec.t, lat: rec.lat, lon: rec.lon, alt: rec.alt };
      state.lostInDescent = false;
      ctx.log('landed', rec.lat !== null ? `${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}` : '');
      bus.emit('landed', state.landed);
    }
  }
  if (state.cutdown && !state.landed) state.lostInDescent = false;
  files.addRecord(rec); state.files.rows = files.records.length;
  if (relay) relay.send({ type: 'telemetry', rec: { ...rec, raw: undefined } });
  bus.emit('telemetry', rec);
  if (state.phase === 'ascent') updateAscentStatus();
}
// signal watchdog: during the descent, 60 s without packets → the landing point becomes an estimate
setInterval(() => {
  if (state.cutdown && !state.landed && state.packets.lastT && now() - state.packets.lastT > 60000 && !state.lostInDescent) {
    state.lostInDescent = true; bus.emit('telemetry', state.last);
  }
}, 5000);
function onLinkEvent(ev) {
  state.events.push(ev);
  if (ev.type === 'cutdown') { state.cutdown = { t: now(), alt: ev.data.alt, altAgl: ev.data.altAgl, by: ev.data.by || 'auto' }; ctx.log(ev.data.by === 'manual' ? 'cutdown.confirmed' : 'cutdown.auto', `${fmtInt(ev.data.altAgl)} m AGL`); toast(t('asc.cutdownEvent', { alt: fmtInt(ev.data.altAgl) })); }
  if (ev.type === 'wireTest') state.wireTest = ev.data;
  if (relay) relay.send({ type: 'event', event: ev });
  bus.emit('event', ev);
}

// ---- ascent session (Worker + relay + files) -------------------------------------------------
let creatingAscent = null;
function createAscent(force) {
  if (state.ascent && !force) return Promise.resolve();
  if (creatingAscent && !force) return creatingAscent;           // one Worker session per ascent, however many views ask for it
  const run = createAscentNow().finally(() => { if (creatingAscent === run) creatingAscent = null; });
  creatingAscent = run;
  return run;
}
async function createAscentNow() {
  const name = `${t('hdr.ascent')} ${fmtDateISO(Date.now())}${state.plan.start.name ? ` · ${state.plan.start.name}` : ''}`;
  const ls0 = state.linkState;
  try {
    // base data of the planned ascent → the Worker builds the WhatsApp message for observers from it
    const r = await api.ascents.create({ name, start: state.plan.start, plannedLaunch: state.plan.result ? state.plan.result.launchMs : null, cutAltAgl: state.plan.cutdownMode === 'alt' ? state.plan.cutAltAgl : null, frequencyHz: ls0.net ? ls0.net.frequencyHz : settings().frequencyHz, sondeId: ls0.sonde ? ls0.sonde.id : null });
    state.ascent = { ascentId: r.ascentId, name, startedAt: Date.now(), notify: r.notify || [] };
    for (const n of state.ascent.notify) if (n.sent) ctx.log('notify.whatsapp', `${n.label} (auto)`);
  } catch (e) { state.ascent = { ascentId: `local-${Date.now()}`, name, startedAt: Date.now(), notify: [] }; toast(`${t('relay.noSession')}: ${e.message}`, true); }
  if (relay) relay.close();
  relay = new Relay({ mock: api.mock });
  relay.addEventListener('open', () => { state.relay.connected = true; bus.emit('relay'); });
  relay.addEventListener('close', () => { state.relay.connected = false; bus.emit('relay'); });
  relay.addEventListener('presence', (e) => { state.relay.presence = e.detail; bus.emit('presence', e.detail); });
  relay.addEventListener('chat', (e) => { state.relay.chat = relay.chat; bus.emit('chat', e.detail); });
  relay.addEventListener('history', () => { state.relay.chat = relay.chat; bus.emit('chat', null); });
  // Incoming telemetry/state/event from the relay are deliberately NOT subscribed here: the ground app is the
  // source of truth, only chat/presence/history come back (the DO refuses those types from observers anyway).
  relay.connect(Relay.buildUrl(settings().relayUrl, state.ascent.ascentId, api.token));
  Object.defineProperty(state.relay, 'sent', { get: () => (relay ? relay.sent : 0), configurable: true });
  Object.defineProperty(state.relay, 'errors', { get: () => (relay ? relay.errors : 0), configurable: true });
  const ls = state.linkState;
  files.begin({ startMs: Date.now(), sondeId: ls.sonde ? ls.sonde.id : null, groundAlt: state.plan.start.alt, receiverAbout: ls.receiver ? `Sparv RR4 hw=${ls.receiver.hw}, fw=${ls.receiver.fw}, prot=${ls.receiver.prot}` : null, receiverMac: ls.receiver ? ls.receiver.mac : null, net: ls.net, name, version: VERSION });
  ctx.log('ascent.created', `${name} · ${state.ascent.ascentId}`);
  bus.emit('relay');
}
async function release({ stay = false } = {}) {
  if (state.released) return;
  state.released = true;
  ctx.log('start.released', t('chk.status.ok'));
  if (state.link && typeof state.link.release === 'function') state.link.release();   // sim: lets go of the balloon
  toast(t('chk.releasedToast'));
  if (!stay) { gotoPhase('ascent', true); return; }
  // Quick start: stay on the page, but the phase flow behind it counts as walked, so «Vollständige Ansicht» (#ascent) opens without loss.
  for (const p of ['plan', 'prepare', 'checks', 'ascent']) state.visited[p] = true;
  state.phase = 'ascent';
  updatePlanStatus(); updatePrepareStatus(); updateChecksStatus();
  ctx.log('phase', phaseLabel('ascent'));
  bus.emit('phase', { phase: 'ascent' });
}
async function archive(to = 'plan') {
  const ok = await confirmDialog({ title: t('ret.archiveTitle'), text: `<p>${esc(t('ret.archiveText'))}</p>`, okLabel: t('ret.archiveOk'), cancelLabel: t('common.cancel') });
  if (!ok) return;
  const wrote = await files.finish();
  if (!wrote) { if (files.records.length) files.downloadAll(); }
  ctx.log('ascent.archived', `${files.base || ''} · ${files.records.length} ${t('ret.expert.points')}`);
  if (state.link) { state.link.stopSession(); try { await state.link.disconnect(); } catch { /* ignore */ } state.link = null; clearInterval(pollTimer); }
  if (relay) { relay.close(); relay = null; }
  resetAscent(); state.linkState = { port: 'closed', receiver: null, sonde: null, net: null, lastRxT: null, rxLines: 0, txLines: 0 };
  state.phase = 'plan'; location.hash = `#${to}`; render();
  toast(t('ret.archived'));
}

// ---- phases / "Weiter" --------------------------------------------------------------------------
function nextPhase(p) { return PHASES[PHASES.indexOf(p) + 1] || null; }
function prevPhase(p) { return PHASES[PHASES.indexOf(p) - 1] || null; }
function gotoPhase(p, force = false) {
  if (!PHASES.includes(p)) return;
  const maxVisited = Math.max(...PHASES.map((x, i) => (state.visited[x] ? i : -1)));
  if (!force && PHASES.indexOf(p) > maxVisited + 1) p = PHASES[maxVisited];
  state.visited[p] = true; state.phase = p;
  if (location.hash !== `#${p}`) location.hash = `#${p}`; else render();
  ctx.log('phase', phaseLabel(p));
}
function weiter() {
  const p = state.phase;
  if (p === 'retrieve') { archive(); return; }
  const st = state.phaseStatus[p];
  const blocked = p === 'plan' && state.plan.cutdownMode === 'none' && !state.plan.noCutdownConfirmed;
  if (blocked) { toast(t('plan.noCutLocked'), true); return; }
  if (st.level === 'ok' || st.acknowledged || state.overridden[p]) { gotoPhase(nextPhase(p)); return; }   // acknowledged: the user already decided (e.g. airspace warning ignored)
  slots.confirm.replaceChildren(renderConfirmStrip({
    level: st.level, text: t('confirm.text', { n: PHASES.indexOf(p) + 1, status: esc(st.summary) }),
    onStay: () => slots.confirm.replaceChildren(),
    onGo: () => { state.overridden[p] = true; ctx.log('phase.override', `${phaseLabel(p)} · ${st.summary}`); slots.confirm.replaceChildren(); gotoPhase(nextPhase(p)); },
  }));
}

// ---- rendering -------------------------------------------------------------------------------------
function expertFor() { return view && view.expert ? view.expert : null; }
function renderHeaderBar() {
  if (!state.session || viewName === 'login') { slots.header.replaceChildren(); slots.action.replaceChildren(); return; }
  if (viewName === 'detail') {
    const tab = (location.hash.split('/')[1] || 'map');
    slots.header.replaceChildren(renderHeader({ mode: 'detail', subtitle: `${state.ascent ? state.ascent.name : ''} · live`, tabs: ['map', 'vertical', 'stueve'].map((id) => ({ id, label: t(`detail.tab.${id}`), on: id === tab })), pill: view.pill ? view.pill() : '', onTab: (tb) => { location.hash = `#detail/${tb}`; }, onClose: () => { location.hash = '#ascent'; } }));
    slots.action.replaceChildren(); return;
  }
  if (viewName === 'quick') {
    slots.header.replaceChildren(renderHeader({ mode: 'quick', subtitle: view && view.subtitle ? view.subtitle() : undefined, quick: view && view.header ? view.header() : '', onLogout: logout }));
    slots.action.replaceChildren(); return;
  }
  const mode = viewName === 'admin' ? 'admin' : 'phases';
  slots.header.replaceChildren(renderHeader({ mode, subtitle: viewName === 'admin' ? t('admin.subtitle') : undefined, expert: expertFor(), onGoto: (p) => gotoPhase(p), onLang: (l) => setLang(l), onLogout: logout, onLog: showLog }));
  if (mode !== 'phases') { slots.action.replaceChildren(); return; }
  const p = state.phase, st = state.phaseStatus[p], prev = prevPhase(p), next = nextPhase(p);
  const nextLabel = p === 'retrieve' ? t('ret.archiveBtn') : `${t('action.next')}: ${phaseLabel(next)} →`;
  slots.action.replaceChildren(renderActionBar({
    back: prev ? { label: phaseLabel(prev) } : null,
    status: `${t('action.step', { n: PHASES.indexOf(p) + 1, total: PHASES.length })} · ${esc(st.summary || '')}`,
    next: { label: nextLabel, level: state.overridden[p] ? 'ok' : st.level, disabled: false },
    quick: p === 'plan' && !state.launch,
    onBack: () => gotoPhase(prev), onNext: weiter,
  }));
}
function renderSimBar() {
  if (!state.sim || !state.session || viewName === 'login') { slots.sim.replaceChildren(); return; }
  const speed = state.link && state.link.opt ? state.link.opt.speed : Number(params.get('speed')) || 1;
  const el = html(`<div class="simbar"><strong>${esc(t('sim.banner'))}</strong><span>${esc(t('sim.note'))}</span><div class="seg" style="width:180px">${[1, 5, 20].map((s) => `<button type="button" data-s="${s}" class="${s === speed ? 'on' : ''}">${s}×</button>`).join('')}</div></div>`);
  el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; const s = Number(b.dataset.s); params.set('speed', s); if (state.link && state.link.setSpeed) state.link.setSpeed(s); renderSimBar(); });
  slots.sim.replaceChildren(el);
}
function showLog() {
  const bg = html(`<div class="modal-bg"><section class="modal" role="dialog"><div class="head"><h1>${esc(t('hdr.protocol'))}</h1><button class="btn icon" type="button" data-x>×</button></div><pre class="log">${esc(state.lines.slice(-400).map((l) => `${fmtTimeUTC(l.t, true)} ${l.dir === 'tx' ? '→' : '←'} ${l.text}`).join('\n')) || esc(t('log.empty'))}</pre></section></div>`);
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-x]')) bg.remove(); });
  document.body.appendChild(bg);
}

function route() {
  const hash = location.hash || '#login';
  const name = hash.slice(1).split('/')[0];
  if (!state.session) { if (name !== 'login') { location.hash = '#login'; return; } }
  else if (name === 'login' || name === '') { location.hash = `#${state.phase}`; return; }
  if (name === 'admin' && !state.session.master) { location.hash = `#${state.phase}`; return; }
  if (PHASES.includes(name) && name !== state.phase) {
    const maxVisited = Math.max(...PHASES.map((x, i) => (state.visited[x] ? i : -1)));
    if (PHASES.indexOf(name) > maxVisited) { location.hash = `#${state.phase}`; return; }
    state.phase = name; state.visited[name] = true;
  }
  if (name === 'detail' && viewName === 'detail' && view.setTab) { view.setTab(hash.split('/')[1] || 'map'); renderHeaderBar(); return; }
  render();
}
function render() {
  const name = (location.hash || '#login').slice(1).split('/')[0];
  if (view) { view.destroy(); view = null; }
  slots.confirm.replaceChildren();
  viewName = name;
  switch (name) {
    case 'login': view = mountLogin(slots.view, { onLogin: login, onLang: (l) => setLang(l) }); break;
    case 'admin': view = mountAdmin(slots.view, ctx); break;
    case 'detail': view = mountDetail(slots.view, ctx, location.hash.split('/')[1] || 'map'); break;
    case 'quick': view = mountQuick(slots.view, ctx); break;
    case 'plan': view = mountPlan(slots.view, ctx); break;
    case 'prepare': view = mountPrepare(slots.view, ctx); break;
    case 'checks': view = mountChecks(slots.view, ctx); break;
    case 'ascent': view = mountAscent(slots.view, ctx); break;
    case 'retrieve': view = mountRetrieve(slots.view, ctx); break;
    default: location.hash = '#plan'; return;
  }
  renderSimBar(); renderHeaderBar();
  // The quick start defers the ascent session until start and cutdown are final; every other page needs it right away.
  if (name !== 'quick' && name !== 'login' && state.link && state.linkState.port === 'open' && !state.ascent) createAscent(false);
  document.title = state.session ? `S2 Ground · ${name === 'detail' ? t('detail.title') : name === 'admin' ? t('admin.title') : name === 'quick' ? t('quick.title') : phaseLabel(state.phase)}` : 'S2 Ground';
}

// ---- boot ----------------------------------------------------------------------------------------------
async function boot() {
  root.innerHTML = '<div id="simbar"></div><div id="header"></div><div id="actionbar"></div><div id="confirm"></div><div id="view"></div>';
  slots.sim = qs(root, '#simbar'); slots.header = qs(root, '#header'); slots.action = qs(root, '#actionbar'); slots.confirm = qs(root, '#confirm'); slots.view = qs(root, '#view');
  await initI18n();
  await files.init(); state.files.supported = files.supported; state.files.folder = files.folderName;
  if (!navigator.serial && !SIM) state.sim = true;   // no Web Serial → simulation (INTERFACE §5)
  await restoreSession();
  onLangChange(() => render());
  bus.on('phase', () => renderHeaderBar());
  window.addEventListener('hashchange', route);
  if (navigator.geolocation) navigator.geolocation.watchPosition((p) => { state.device = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }; bus.emit('device', state.device); }, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
  if (!state.session) { location.hash = '#login'; }
  else if (!location.hash || location.hash === '#login') location.hash = '#plan';
  if (SIM && params.get('device') !== '0') state.device = { lat: 47.4150, lon: 8.5500, acc: 20 };   // demo "Ich" position (Zürich-Oerlikon)
  route();
}
boot();
