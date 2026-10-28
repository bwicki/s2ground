// S2 sonde procedures (spec §4.3, §5.5, §5.7, §5.8, §6.1, §6.3). Text channel first (proven):
// cut-down, wire/LED test, mode, parameters and relAP go through `<id>.exe=`; SSP is used for
// status subscriptions, net push and GNSS aiding. Every [I]/[U] behaviour sits behind an option
// in `link.opts` with a TODO naming the open question of spec §8.

import { isaAltitude, isaPressure } from '../util/format.js';
import { SYM, typedNet } from './ssp-session.js';
import { plain, REF } from './ssp-bin.js';
import { decodeWireTest } from './telemetry.js';

const SUB_SYMS = [SYM.gnssEnabled, SYM.md, SYM.mac, SYM.bat, SYM.net, SYM.condition, SYM.pr, SYM.txCriterion, SYM.power_dBm, SYM.powerBeforeLaunch_dBm, SYM.role];   // + role (3.11.8)
export const ROLES = { 1: 'reusable radiosonde', 2: 'one-time radiosonde', 3: 'dropsonde', 4: 'tethersonde', 6: 'receiver' };   // spec §4.3 (4 = 3.11.8)
export const LANDED_BEHAVIOUR = { 0: 'power-save', 1: 'beacon at once', 2: 'continue sounding' };   // behlan / findme=<n> (2 = 3.11.8)
const ERR_BITS = ['hardware error', 'missing GPS or comm', 'temp/RH sensor error', 'external sensor error', 'radio hardware error', 'missing/broken flash', 'pressure sensor error', 'battery error', 'cut-down test failed', 'corrupt/full memory', 'light sensor error'];
const WARN_BITS = ['missing sensor calibration', 'no time source', 'no GPS fix', 'low memory', 'low battery', 'sensors not ready', 'no radio contact', 'initialising'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** §6.3 condition bitmap → text list ([] = "Everything OK"). */
export function conditionText(bits) {
  if (bits === null || bits === undefined) return [];
  const out = [];
  ERR_BITS.forEach((t, i) => { if (bits & (1 << i)) out.push(t); });
  WARN_BITS.forEach((t, i) => { if (bits & (1 << (16 + i))) out.push(t); });
  return out;
}
function sonde(link) {
  if (!link.ls.sonde) link.ls.sonde = { id: null, name: null, componentId: null, type: null, md: null, batV: null, pr: null, condition: null, conditionText: [], powerDbm: null, powerBeforeLaunchDbm: null, txCriterion: null, fwver: null, cutAltAgl: null, role: null, sats: null, agl: null, gnssEnabled: null, lastT: null };
  return link.ls.sonde;
}
function requireId(link) {
  const s = link.ls.sonde;
  if (!s || s.id === null || s.id === 255 || s.id === 65535) throw new Error('E_NO_SONDE');
  return s.id;
}

// ---- §5.3 step 5: the S2 object appeared in `components` -----------------------------------------
export async function attach(link, oid, name) {
  const ssp = link.ssp, tm = link.opts.timing, s = sonde(link);
  s.componentId = oid; s.name = name; link.ls.s2Oid = oid;
  // TODO spec §8 Q8: where is "S2H3-R-B20" readable? Guess: object name "S2_H3-R-B20" / "S2H3-R-B20"
  const tm2 = link.opts.sondeTypeFromName ? /^S2[_-]?([A-Z0-9]+-.+)$/i.exec(name) : null;
  if (tm2) s.type = `S2${tm2[1]}`;
  try { link.ls.s2Types = await ssp.getVarType(oid, SUB_SYMS, tm.sspReplyMs); } catch (e) { link.warn(`getVarType S2: ${e.message}`); }
  for (let i = 0; i < 3; i++) {
    const p = waitAny(ssp, oid, tm.sspReplyMs); p.catch(() => {});      // handled below (await), never unhandled
    try { await ssp.sub(oid, SUB_SYMS); await p; break; } catch { /* retry */ }
  }
  // 3.11.8: when the RR4 holds `sspDefaultSet` it pushes net/txCriterion/power itself (spec §5.5a) – do not race it
  if (link.opts.pushNetToS2 && !link.ls.autoSync) { try { await pushNet(link); } catch (e) { link.warn(`push net to S2: ${e.message}`); } }
  link.emitState();
}
export function detach(link) { link.ls.s2Oid = null; if (link.ls.sonde) { link.ls.sonde.componentId = null; } }
function waitAny(ssp, oid, ms) {
  return new Promise((resolve, reject) => {
    const h = (e) => { if (e.detail.oid === oid) { clearTimeout(tm); ssp.removeEventListener('report', h); resolve(e.detail.values); } };
    const tm = setTimeout(() => { ssp.removeEventListener('report', h); reject(new Error('E_TIMEOUT: no S2 report')); }, ms);
    ssp.addEventListener('report', h);
  });
}
/** SSP report from the S2 object → SondeInfo fields (spec §4.3). */
export function onReport(link, values) {
  const s = sonde(link);
  const v = (sym) => (values.has(sym) ? plain(values.get(sym)) : undefined);
  const set = (key, sym, f = (x) => x) => { const x = v(sym); if (x !== undefined && x !== null) s[key] = f(x); };
  set('md', SYM.md); set('id', SYM.mac); set('batV', SYM.bat); set('pr', SYM.pr); set('txCriterion', SYM.txCriterion);
  set('powerDbm', SYM.power_dBm); set('powerBeforeLaunchDbm', SYM.powerBeforeLaunch_dBm); set('gnssEnabled', SYM.gnssEnabled, (x) => !!x);
  set('role', SYM.role, (x) => Number(x));
  if (values.has(SYM.condition)) { s.condition = plain(values.get(SYM.condition)); s.conditionText = conditionText(s.condition); }
  if (values.has(SYM.net)) s.net = plain(values.get(SYM.net));
}
/** Telemetry-based sonde info (works without SSP): id, md, battery, pressure, params from `params=` queries. */
export function onTelemetry(link, p, t) {
  if (p.id === undefined || p.id === null || p.id === 255 || p.id === 65535) return;
  const s = sonde(link);
  if (s.id !== null && s.id !== p.id && link.opts.lockSondeId) return;    // another sonde on the frequency – ignore
  s.id = p.id; s.lastT = t;
  if (p.md !== undefined) s.md = p.md; if (p.su !== undefined) s.batV = p.su; if (p.pa !== undefined) s.pr = p.pa; if (p.sats !== undefined) s.sats = p.sats;
  if (p.fwver !== undefined) s.fwver = String(p.fwver); if (p.role !== undefined) s.role = p.role; if (p.hw !== undefined) s.hw = p.hw;
  if (p.cutalt !== undefined) s.cutAltAgl = p.cutalt === 65535 ? null : p.cutalt;
  if (p.fwver !== undefined || p.cutalt !== undefined || p.role !== undefined) s.paramsSeen = (s.paramsSeen || 0) + 1;
  if (p.behlan !== undefined) s.behlan = p.behlan; if (p.supmul !== undefined) s.supmul = p.supmul;
}
/** Copy the RR4's net struct to the S2 (`set net`, spec §5.5) and verify via the S2's next net report. */
export async function pushNet(link) {
  if (!link.ls.s2Oid || !link.ls.netStruct) throw new Error('E_NO_SONDE');
  const schema = typeof link.ls.netSchema === 'number' ? link.ls.netSchema : ('netId' in link.ls.netStruct ? REF.NET_V5 : REF.NET_V6);
  await link.ssp.set(link.ls.s2Oid, new Map([[SYM.net, typedNet(schema, link.ls.netStruct)]]), link.opts.timing.sspReplyMs);
  try { const [net] = await link.ssp.uget(link.ls.s2Oid, [SYM.net], link.opts.timing.sspReplyMs); const got = plain(net); if (got && got.freq !== link.ls.netStruct.freq) throw new Error(`E_SET_MISMATCH: S2 freq ${got.freq}`); }
  catch (e) { if (/E_SET_MISMATCH/.test(e.message)) throw e; }
}

// ---- reads ------------------------------------------------------------------------------------------
/** SSP ugets (when the S2 object is reachable) + `params=06,13,15,17` via text → SondeInfo snapshot. */
export async function readSonde(link) {
  const s = sonde(link), tm = link.opts.timing;
  if (link.ls.s2Oid && link.ssp.joined) {
    const syms = [SYM.name, SYM.md, SYM.mac, SYM.bat, SYM.pr, SYM.condition, SYM.power_dBm, SYM.txCriterion, SYM.powerBeforeLaunch_dBm];
    try {
      const vals = await link.ssp.uget(link.ls.s2Oid, syms, tm.nameReplyMs);
      const m = new Map(syms.map((k, i) => [k, vals[i]]));
      onReport(link, m); s.name = String(m.get(SYM.name) ?? s.name);
    } catch (e) { link.warn(`uget S2: ${e.message}`); }
    if (link.opts.readFwVerStr) { try { const [v] = await link.ssp.uget(link.ls.s2Oid, [SYM.fwVerStr], tm.nameReplyMs); s.fwver = String(v); } catch { /* [I] symbol, TODO spec §8 Q8 */ } }
  }
  if (s.id !== null && link.hasTextChannel()) {
    try {
      // the sonde answers `params=` by adding the parameters to its next packets (spec §5.8)
      const seen = s.paramsSeen || 0;
      await link.text.exe(s.id, 'params=06,13,15,17', { timeoutMs: tm.exeTimeoutMs });
      await waitFor(() => (s.paramsSeen || 0) > seen, tm.paramsWaitMs);
    } catch (e) { link.warn(`params: ${e.message}`); }
  }
  link.emitState();
  return link.state.sonde;
}
async function waitFor(cond, ms) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) return false; await sleep(100); } return true; }

// ---- commands (§5.8) ----------------------------------------------------------------------------------
/**
 * Cut-down altitude: `relAP=<pressure/2>:<alt AGL>`; the release pressure is ISA from the ground
 * pressure (groundPa). Read-back via `params=15` (cutalt). Optional SSP `set relAlt` behind
 * S2_TRY_SSP_RELALT (TODO spec §8 Q1/Q11).
 */
export async function setCutdownAltitude(link, mAgl, groundPa) {
  const id = requireId(link), tm = link.opts.timing, s = sonde(link);
  const alt = Math.round(mAgl);
  const gPa = groundPa || s.pr || link.ls.receiver?.pa || 101325;
  const relPa = Math.round(isaPressure(isaAltitude(gPa) + alt));
  const half = Math.round(relPa / 2);
  const res = await link.text.exe(id, `relAP=${half}:${alt}`, { timeoutMs: tm.exeTimeoutMs });
  if (link.opts.S2_TRY_SSP_RELALT && link.ls.s2Oid) {
    try { await link.ssp.set(link.ls.s2Oid, new Map([[SYM.relAlt, alt]]), tm.sspReplyMs); } catch (e) { link.warn(`SSP relAlt: ${e.message}`); }
  }
  const seen = s.paramsSeen || 0; s.cutAltAgl = null;
  try { await link.text.exe(id, 'params=15', { timeoutMs: tm.exeTimeoutMs }); await waitFor(() => (s.paramsSeen || 0) > seen, tm.paramsWaitMs); } catch (e) { link.warn(`params=15: ${e.message}`); }
  link.emitState();
  if ((s.paramsSeen || 0) > seen) return s.cutAltAgl;                 // read back (null = 65535 = none)
  return /ok|relAP/i.test(res) ? alt : null;                          // no read-back: trust the RES text
}
export async function setMode(link, n) {
  const id = requireId(link);
  return link.text.exe(id, `mode=${Number(n)}`, { timeoutMs: link.opts.timing.exeTimeoutMs });
}
/** `wires` (one-way per spec §5.8) → wait for the TXT `R(…)` report ≤ 8 s → decoded result. */
export async function ledAndWireTest(link) {
  const id = requireId(link), tm = link.opts.timing;
  const p = waitEvent(link, 'wireTest', tm.exeTimeoutMs);
  await link.text.exe(id, 'wires', { timeoutMs: tm.exeTimeoutMs, oneway: !link.opts.wiresViaExe });
  const ev = await p;
  return { ...ev.data, raw: ev.raw };
}
function waitEvent(link, type, ms) {
  return new Promise((resolve, reject) => {
    const h = (e) => { if (e.detail.type === type) { clearTimeout(tm); link.removeEventListener('event', h); resolve(e.detail); } };
    const tm = setTimeout(() => { link.removeEventListener('event', h); reject(new Error(`E_TIMEOUT_RADIO: no ${type} report`)); }, ms);
    link.addEventListener('event', h);
  });
}
/**
 * Manual cut-down (spec §5.8): `relBal=150` on the ground (init/ready/resting/find-me); in flight
 * **`mode=7`** for an S2 (what Windsond 3.11.8 sends – the 3.9.0 "cut-down now delay" fix) or
 * `relBal` (3.8.0 behaviour, option s2CutdownViaMode7=false).
 */
export async function cutdown(link) {
  const id = requireId(link), s = sonde(link);
  // In flight by the sonde's own mode – or by our telemetry (> 35 m AGL = the PC-side launch
  // criterion of spec §6.2) when the sonde still reports init/ready: never send the 150 ms
  // ground burn to an airborne sonde.
  const inFlight = s.md === 2 || s.md === 3 || s.md === 7 || s.md === 'A' || (typeof s.agl === 'number' && s.agl > 35);
  link.tele.lastManualCutT = Date.now();
  const cmd = !inFlight ? `relBal=${link.opts.relBalGroundMs}` : (link.opts.s2CutdownViaMode7 ? 'mode=7' : 'relBal');
  const res = await link.text.exe(id, cmd, { timeoutMs: link.opts.timing.exeTimeoutMs });
  return res;
}
/**
 * Secondary cut-down `relGnd`. 3.11.8 (3.11.7 "error check for secondary cut-down"): the action is
 * confirmed only when the RES text starts with `C` (the sonde's cut-down report); anything else is
 * rejected with E_CUTDOWN2_UNCONFIRMED (option strictRelGnd=false → return the RES as in 3.8.0).
 */
export async function cutdownSecondary(link) {
  const res = await link.text.exe(requireId(link), 'relGnd', { timeoutMs: link.opts.timing.exeTimeoutMs });
  if (link.opts.strictRelGnd && !/^\s*C/.test(res || '')) throw Object.assign(new Error(`E_CUTDOWN2_UNCONFIRMED: ${res || '(empty)'}`), { res });
  return res;
}
/** 3.11.8: change the role of a connected S2 over SSP (`set role`, 3 attempts × 1 s). 1 reusable, 2 one-time, 3 dropsonde, 4 tethersonde. */
export async function setRole(link, role) {
  const n = Number(role);
  if (!ROLES[n] || n === 6) throw new Error(`E_ARG: role ${role}`);
  if (!link.ls.s2Oid || !link.ssp || !link.ssp.joined) throw new Error('E_NO_SONDE: S2 not reachable over SSP');
  let err = null;
  for (let i = 0; i < 3; i++) {
    try { await link.ssp.set(link.ls.s2Oid, new Map([[SYM.role, n]]), 1000); sonde(link).role = n; link.emitState(); return n; }
    catch (e) { err = e; if (e.code === 5) throw new Error('E_NO_ROLE: S2 does not have role'); }
  }
  throw new Error(`E_SET_FAILED: role: ${err && err.message}`);
}
/** Behaviour after landing: `findme=<0|1|2>` (0 power-save, 1 beacon at once, 2 continue sounding – 3.11.8). */
export async function setLandedBehaviour(link, n) {
  const v = Number(n);
  if (!LANDED_BEHAVIOUR[v]) throw new Error(`E_ARG: behaviour ${n}`);
  const res = await link.text.exe(requireId(link), `findme=${v}`, { timeoutMs: link.opts.timing.exeTimeoutMs });
  sonde(link).behlan = v;
  return res;
}
export async function beep(link) { return link.text.exe(requireId(link), `beep=${link.opts.beepHz}`, { timeoutMs: link.opts.timing.exeTimeoutMs }); }
export async function sendExe(link, text, { timeoutMs = link.opts.timing.exeTimeoutMs } = {}) { return link.text.exe(requireId(link), text, { timeoutMs }); }

// ---- §5.7 ephemeris upload ----------------------------------------------------------------------------
/** Split a UBX stream into frames (len = 6 + payloadLen + 2); stops at the first non-UBX byte. */
export function splitUbx(data) {
  const frames = [];
  let i = 0;
  while (i + 8 <= data.length) {
    if (data[i] !== 0xb5 || data[i + 1] !== 0x62) break;
    const len = 6 + (data[i + 4] | (data[i + 5] << 8)) + 2;
    if (i + len > data.length) break;
    frames.push(data.slice(i, i + len)); i += len;
  }
  return frames;
}
/** Prefix 0xFF, cut into ≤ chunkBytes, `call gnssCmd(Blob)` with up to `aidChunkRetries` attempts per chunk (5 in 3.11.8, 2 in 3.8.0; TODO spec §8 Q13). */
export async function gnssAidToSonde(link, data) {
  if (!link.ls.s2Oid || !link.ssp.joined) throw new Error('E_NO_SONDE: S2 not reachable over SSP');
  const s = sonde(link);
  if (typeof s.md === 'number' && s.md >= 8) throw new Error('E_SONDE_OFF: S2 not turned on');
  if (s.gnssEnabled === false) throw new Error('E_GNSS_OFF: S2 GNSS not enabled');
  const frames = splitUbx(data);
  if (!frames.length) throw new Error('E_NO_AID: no UBX frames');
  const chunks = [];
  for (const f of frames) {
    const pre = new Uint8Array(f.length + 1); pre[0] = 0xff; pre.set(f, 1);
    for (let o = 0; o < pre.length; o += link.opts.aidChunkBytes) chunks.push(pre.slice(o, o + link.opts.aidChunkBytes));
  }
  for (let i = 0; i < chunks.length; i++) {
    let ok = false;
    const tries = Math.max(1, link.opts.aidChunkRetries || 5);
    for (let attempt = 0; attempt < tries && !ok; attempt++) {
      try { await link.ssp.call(link.ls.s2Oid, SYM.gnssCmd, chunks[i], link.opts.timing.sspReplyMs); ok = true; }
      catch (e) { if (attempt === tries - 1) throw new Error(`E_AID_UPLOAD: chunk ${i + 1}/${chunks.length}: ${e.message}`); }
    }
    link.progress({ phase: 'upload', done: i + 1, total: chunks.length });
  }
  link.ls.aidUploadT = Date.now();
  return chunks.length;
}
export { decodeWireTest };
