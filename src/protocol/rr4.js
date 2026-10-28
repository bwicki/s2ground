// RR4 receiver procedures (spec §5.1 handshake, §5.3 discovery, §5.4 settings, §5.7 A aiding data).
// Functions take the GroundLink (`link`) for access to serial/text/ssp and the mutable link
// state `link.ls`; they never touch the UI. Where the spec is [I]/[U], behaviour sits behind
// `link.opts` flags with a TODO naming the open question.

import { parseAbout } from './lines.js';
import { SYM, CENTRAL_ID, typedNet } from './ssp-session.js';
import { plain, REF, Typed, T } from './ssp-bin.js';
import * as s2 from './s2.js';

const BW_HZ = [125000, 250000, 500000];              // loraBandwidth code → Hz (spec §5.4)

/**
 * Allowed frequency spans in Hz (spec §5.4, 3.11.8): the default GUI span and the extended
 * ("defence") span. A licence may narrow the span further in the original software – that mechanism
 * is deliberately not implemented; `custom` lets the owner enter whatever the RR4 accepts.
 */
export const FREQ_RANGES = {
  default: { minHz: 400e6, maxHz: 440e6, label: '400–440 MHz' },     // [C] 3.11.8 default
  extended: { minHz: 390e6, maxHz: 440e6, label: '390–440 MHz' },    // [C] 3.11.8 "wide"/defence option (3.10.1 fixed 390–400)
  legacy380: { minHz: 400e6, maxHz: 450e6, label: '400–450 MHz' },   // [C] the 3.8.0 hard limit of the text setter (kept for comparison)
};
/** Resolve `link.opts.freqRange` ('default' | 'extended' | {minHz, maxHz}) to a span. */
export function freqRange(opt) {
  if (opt && typeof opt === 'object' && Number.isFinite(opt.minHz) && Number.isFinite(opt.maxHz)) return { ...opt, label: opt.label || `${opt.minHz / 1e6}–${opt.maxHz / 1e6} MHz` };
  return FREQ_RANGES[opt] || FREQ_RANGES.default;
}
/** Throws E_FREQ_RANGE when `hz` lies outside the allowed span (checked *before* anything is sent, like 3.11.8). */
export function checkFrequency(hz, opt = 'default') {
  const r = freqRange(opt);
  if (!Number.isFinite(hz) || hz < r.minHz || hz > r.maxHz) throw new Error(`E_FREQ_RANGE: ${Number.isFinite(hz) ? (hz / 1e6).toFixed(3) : hz} MHz outside ${r.label}`);
  return Math.round(hz);
}

// ---- §5.1 handshake over the text channel ---------------------------------------------------------
export async function handshake(link) {
  const text = link.text, tm = link.opts.timing;
  // echo=0: 2 s, up to 5 tries (the first reply after power-up can be slow / garbled)
  let echoOk = false;
  for (let i = 0; i < 5 && !echoOk; i++) {
    try { const r = await text.command('echo=0', { timeoutMs: tm.firstEchoMs }); echoOk = /^(echo=0)?$/i.test(r.trim()) || /echo/i.test(r); } catch { /* retry */ }
  }
  if (!echoOk) throw new Error('E_HANDSHAKE: no reply to echo=0');
  let mac = null;
  for (let i = 0; i < 5 && mac === null; i++) {
    try { const r = await text.command('mac', { timeoutMs: tm.responseMs }); const m = /^mac\s*=\s*([0-9a-f]+)/i.exec(r); if (m) mac = m[1].toUpperCase(); } catch { /* retry */ }
  }
  let about = null;
  for (let i = 0; i < 3 && !about; i++) {
    try { const r = await text.command('about', { timeoutMs: tm.responseMs }); if (/about/i.test(r) || /Sparv|RR/i.test(r)) about = parseAbout(r); } catch { /* retry */ }
  }
  const a = about || { product: null, hw: null, fw: null, prot: null, raw: '' };
  const legacy = a.product && /RR2|Windsond receiver/i.test(a.product);
  return { hw: a.hw, fw: a.fw, prot: a.prot, mac, about: a.raw, product: a.product, sspCapable: !legacy, lora: a.prot !== null && a.prot >= 5 };
}

// ---- §5.3 discovery -------------------------------------------------------------------------------
/** Subscribe `components` on the central and classify every object by its `name`. */
export async function discover(link) {
  const ssp = link.ssp, tm = link.opts.timing;
  let comps = null;
  for (let i = 0; i < 4 && !comps; i++) {
    const p = waitReport(ssp, CENTRAL_ID, SYM.components, tm.sspReplyMs); p.catch(() => {});
    await ssp.sub(CENTRAL_ID, [SYM.components]);
    try { comps = await p; } catch { /* retry */ }
  }
  if (!comps) throw new Error('E_SSP_NO_COMPONENTS');
  await link._discovery;                                   // the report handler already started classifying
}
/**
 * (Re)classify the component list; called on every `components` report (spec §5.3 step 4).
 * Calls are serialised on link._discovery so a second report cannot race the first classification.
 */
export function onComponents(link, list) {
  link._discovery = (link._discovery || Promise.resolve()).then(() => classify(link, list)).catch((e) => link.warn(`discovery: ${e.message}`));
  return link._discovery;
}
async function classify(link, list) {
  const ids = plain(list);
  const oids = (Array.isArray(ids) ? ids : []).map(Number).filter((o) => o && o !== link.ssp.id);
  link.ls.components = oids;
  for (const oid of oids) {
    if (link.known.has(oid)) continue;
    link.known.set(oid, 'pending');
    const name = await ugetName(link, oid);
    link.known.set(oid, name || '?');
    if (name && /^RR4/i.test(name)) { link.ls.rr4Oid = oid; link.ls.receiver && (link.ls.receiver.componentId = oid); await attachRr4(link, oid); }
    else if (name && /^S2/i.test(name)) { await s2.attach(link, oid, name); }
  }
  // S2 vanished from the list → drop its SSP identity (telemetry-based sonde info stays)
  if (link.ls.s2Oid && !oids.includes(link.ls.s2Oid)) s2.detach(link);
  for (const k of [...link.known.keys()]) if (!oids.includes(k)) link.known.delete(k);
  link.emitState();
}
async function ugetName(link, oid) {
  for (let i = 0; i < 3; i++) {
    try { const [name] = await link.ssp.uget(oid, [SYM.name], link.opts.timing.nameReplyMs); return String(name); } catch { /* retry */ }
  }
  return null;
}
/** getVarType + sub for the RR4's utcSyncSource, gnssHasAid, net, encKey; the first report delivers `net`. */
async function attachRr4(link, oid) {
  const ssp = link.ssp, tm = link.opts.timing;
  const syms = [SYM.utcSyncSource, SYM.gnssHasAid, SYM.net, SYM.encKey];
  for (let i = 0; i < 3; i++) {
    try {
      const types = await ssp.getVarType(oid, syms, tm.sspReplyMs);
      link.ls.netSchema = types[2].schema;               // REF105 or REF102 (spec §8 Q4)
      break;
    } catch (e) { if (i === 2) link.warn(`getVarType RR4: ${e.message}`); }
  }
  let gotNet = false;
  for (let i = 0; i < 3 && !gotNet; i++) {
    const p = waitReport(ssp, oid, SYM.net, tm.sspReplyMs); p.catch(() => {});
    try { await ssp.sub(oid, syms); await p; gotNet = true; } catch { /* retry */ }
  }
  if (!gotNet) link.warn('RR4 did not report net after subscribe');
  // 3.11.8: RR4 firmware with `sspDefaultSet` syncs the S2 itself (spec §5.5a) – detect and seed it
  link.ls.autoSync = null;
  if (link.opts.rr4AutoSync) { try { await syncDefaultSet(link); } catch (e) { link.warn(`sspDefaultSet: ${e.message}`); } }
}

// ---- §5.5a RR4 auto-sync (3.11.8) -----------------------------------------------------------------
/**
 * Detect `sspDefaultSet` (477) on the RR4; when present, make sure it carries the RR4's current `net`
 * (plus txCriterion / power when configured in link.opts.s2Defaults) so the RR4 pushes the settings to
 * every S2 it sees. Returns true when the RR4 supports it. [C] procedure, [I] `opt` bit semantics.
 */
export async function syncDefaultSet(link) {
  const ssp = link.ssp, oid = link.ls.rr4Oid, tm = link.opts.timing;
  if (!ssp || !ssp.joined || !oid) throw new Error('E_SSP_NOT_JOINED');
  let supported = false, schema = REF.DEFAULT_SET;
  try {
    const [t] = await ssp.getVarType(oid, [SYM.sspDefaultSet], tm.sspReplyMs);
    // a real schema (REF116 expected); null/Any means the RR4 does not know the variable [I]
    supported = !!t && typeof t.schema === 'number' && t.schema !== T.NULL && t.schema !== T.ANY;
    if (supported && typeof t.schema === 'number') schema = t.schema;
  } catch (e) { supported = false; }               // nack (unknown variable) or timeout = old firmware
  link.ls.autoSync = supported ? { schema, written: false } : false;
  if (!supported || !link.ls.netStruct) return supported;
  // current value (0.5 / 1 / 1.5 s retries like the original)
  let cur = null;
  for (const ms of [500, 1000, 1500]) { try { [cur] = await ssp.uget(oid, [SYM.sspDefaultSet], ms); break; } catch { /* retry */ } }
  const want = buildDefaultSet(link);
  const curNet = cur && Array.isArray(cur) && cur[1] instanceof Map ? plain(cur[1].get(SYM.net) ?? cur[1].get(String(SYM.net))) : null;
  const same = curNet && JSON.stringify(curNet) === JSON.stringify(link.ls.netStruct) && sameExtras(cur[1], want.map);
  if (!same) {
    try { await ssp.set(oid, new Map([[SYM.sspDefaultSet, new Typed(schema, [want.opt, want.map])]]), tm.sspReplyMs); }
    catch (e) { if (e.code === 5 || e.code === 14) { link.ls.autoSync = false; return false; } throw e; }   // unknown variable / unsupported → old push path
    link.ls.autoSync.written = true;
  }
  return true;
}
/** The tuple (opt, NameMap) the RR4 should hold: net always, the rest only when configured (spec §5.5a). */
export function buildDefaultSet(link) {
  const d = link.opts.s2Defaults || {};
  const netSchema = typeof link.ls.netSchema === 'number' ? link.ls.netSchema : ('netId' in link.ls.netStruct ? REF.NET_V5 : REF.NET_V6);
  const map = new Map([[SYM.net, typedNet(netSchema, link.ls.netStruct)]]);
  let opt = 0, n = 1;
  if (d.txCriterion !== undefined && d.txCriterion !== null) { map.set(SYM.txCriterion, new Typed(T.U8, d.txCriterion)); n++; }
  if (d.powerDbm !== undefined && d.powerDbm !== null) { map.set(SYM.power_dBm, new Typed(T.I16, d.powerDbm)); n++; }
  if (d.powerBeforeLaunchDbm !== undefined && d.powerBeforeLaunchDbm !== null) { opt |= 1 << n; map.set(SYM.powerBeforeLaunch_dBm, new Typed(T.I16, d.powerBeforeLaunchDbm)); n++; }   // always flagged optional [C]
  return { opt, map };
}
function sameExtras(curMap, wantMap) {
  for (const [k, v] of wantMap) { if (k === SYM.net) continue; const c = curMap.get(k); if (c === undefined || plain(c) !== plain(v)) return false; }
  return true;
}

// ---- §1.8 WiFi configuration (3.11.8) --------------------------------------------------------------
const WIFI_VARS = [['enabled', SYM.wifiEnabled], ['ap', SYM.wifiAp], ['apSsid', SYM.wifiApSsid], ['apPwd', SYM.wifiApPwd], ['clientSsid', SYM.wifiClientSsid], ['clientPwd', SYM.wifiClientPwd]];
/** `ipAddr` as reported: string, or Uint32 with the first octet in the most significant byte (spec §1.8). */
export function ipAddrToString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  const n = Number(v); if (!Number.isFinite(n) || n === 0) return '';
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}
/** Read the RR4's WiFi settings over SSP (USB). Rejects E_NO_WIFI when the firmware lacks the variables. */
export async function readWifi(link) {
  const ssp = link.ssp, oid = link.ls.rr4Oid;
  if (!ssp || !ssp.joined || !oid) throw new Error('E_SSP_NOT_JOINED');
  const out = { enabled: null, ap: null, apSsid: '', apPwd: '', clientSsid: '', clientPwd: '', ipAddr: '' };
  for (const [key, sym] of WIFI_VARS) {
    let v;
    try { [v] = await ssp.uget(oid, [sym], 1000); }
    catch (e) { if (e.code === 5 || /unknown variable/.test(e.message)) throw new Error('E_NO_WIFI: receiver does not support WiFi'); throw e; }
    v = plain(v);
    out[key] = key === 'enabled' || key === 'ap' ? (v === null ? null : !!v) : String(v ?? '');
  }
  try { const [ip] = await ssp.uget(oid, [SYM.ipAddr], 1000); out.ipAddr = ipAddrToString(plain(ip)); } catch { /* ipAddr is report-only on some firmware */ }
  try { await ssp.sub(oid, [SYM.ipAddr]); } catch { /* best effort */ }
  link.ls.wifi = out;
  return { ...out };
}
/**
 * Write changed WiFi settings and commit with `wifiApply` (spec §1.8): set each changed value (1 s,
 * 3 attempts), call wifiApply (5 s, 3 attempts), re-read after 0.5 s. `mode` shortcut:
 * 'off' | 'client' | 'ap' sets enabled/ap accordingly.
 */
export async function writeWifi(link, patch = {}) {
  const ssp = link.ssp, oid = link.ls.rr4Oid;
  if (!ssp || !ssp.joined || !oid) throw new Error('E_SSP_NOT_JOINED');
  const p = { ...patch };
  if (p.mode === 'off') { p.enabled = false; } else if (p.mode === 'client') { p.enabled = true; p.ap = false; } else if (p.mode === 'ap') { p.enabled = true; p.ap = true; }
  const cur = link.ls.wifi || await readWifi(link);
  for (const [key, sym] of WIFI_VARS) {
    if (p[key] === undefined || p[key] === null || p[key] === cur[key]) continue;
    const val = key === 'enabled' || key === 'ap' ? !!p[key] : String(p[key]);
    let ok = false, err = null;
    for (let i = 0; i < 3 && !ok; i++) { try { await ssp.set(oid, new Map([[sym, val]]), 1000); ok = true; } catch (e) { err = e; if (e.code === 5) throw new Error('E_NO_WIFI: receiver does not support WiFi'); } }
    if (!ok) throw new Error(`E_WIFI_SET: ${key}: ${err && err.message}`);
  }
  let applied = false, err = null;
  for (let i = 0; i < 3 && !applied; i++) { try { await ssp.call(oid, SYM.wifiApply, null, 5000); applied = true; } catch (e) { err = e; } }
  if (!applied) throw new Error(`E_WIFI_APPLY: ${err && err.message}`);
  await new Promise((r) => setTimeout(r, 500));
  link.ls.wifi = null;
  return readWifi(link);
}
/** Resolve with the value of `sym` in the next report from `oid` (or reject after ms). */
export function waitReport(ssp, oid, sym, ms) {
  return new Promise((resolve, reject) => {
    const h = (e) => { if (e.detail.oid === oid && e.detail.values.has(sym)) { clearTimeout(tm); ssp.removeEventListener('report', h); resolve(e.detail.values.get(sym)); } };
    const tm = setTimeout(() => { ssp.removeEventListener('report', h); reject(new Error(`E_TIMEOUT: no report ${oid}/${sym}`)); }, ms);
    ssp.addEventListener('report', h);
  });
}
/** Reports from the RR4 object → receiver state / net (spec §4.2). */
export function onReport(link, values) {
  const rx = link.ls.receiver;
  if (values.has(SYM.net)) { link.ls.netStruct = plain(values.get(SYM.net)); link.ls.net = netFromStruct(link.ls.netStruct); if (link.ls.net.sampleMs) link.tele.sampleMs = link.ls.net.sampleMs; }
  if (rx) {
    if (values.has(SYM.utcSyncSource)) rx.utcSyncSource = plain(values.get(SYM.utcSyncSource));
    if (values.has(SYM.gnssHasAid)) rx.gnssHasAid = !!plain(values.get(SYM.gnssHasAid));
    if (values.has(SYM.ipAddr)) { rx.ipAddr = ipAddrToString(plain(values.get(SYM.ipAddr))); if (link.ls.wifi) link.ls.wifi.ipAddr = rx.ipAddr; }
  }
}

// ---- §5.4 net settings ----------------------------------------------------------------------------
/** REF105/102 struct → NetSettings as the UI shows them (bw in Hz, cr as the 4/<cr> denominator). */
export function netFromStruct(s) {
  if (!s) return null;
  return { frequencyHz: s.freq ?? null, timeslots: s.radioTimeslots ?? null, slotMs: s.radioSlotMs ?? null, sf: s.loraSpreadingFactor ?? null,
    bw: s.loraBandwidth === undefined ? null : BW_HZ[s.loraBandwidth] ?? s.loraBandwidth, cr: s.loraCodingRate === undefined ? null : 4 + s.loraCodingRate,
    groundSlot: s.radioGroundSlotMs ?? null, sampleMs: s.samplingInterval ?? null, maxData: s.radioMaxData ?? null, netId: s.netId ?? null };
}
export function structFromNet(net, base = {}) {
  const bwCode = net.bw === null || net.bw === undefined ? base.loraBandwidth : (BW_HZ.indexOf(net.bw) >= 0 ? BW_HZ.indexOf(net.bw) : net.bw);
  const s = { ...base, freq: net.frequencyHz ?? base.freq, loraSpreadingFactor: net.sf ?? base.loraSpreadingFactor, loraBandwidth: bwCode,
    loraCodingRate: net.cr === null || net.cr === undefined ? base.loraCodingRate : (net.cr >= 5 ? net.cr - 4 : net.cr), radioTimeslots: net.timeslots ?? base.radioTimeslots,
    radioSlotMs: net.slotMs ?? base.radioSlotMs, radioMaxData: net.maxData ?? base.radioMaxData, samplingInterval: net.sampleMs ?? base.samplingInterval, radioGroundSlotMs: net.groundSlot ?? base.radioGroundSlotMs };
  if ('netId' in base) s.netId = base.netId;
  return s;
}
/** Current net: from the SSP report when available, else the classic text queries (spec §5.4). */
export async function readNet(link) {
  if (!link.ls.net && link.ssp && link.ssp.joined && link.ls.rr4Oid) {
    try { await waitReport(link.ssp, link.ls.rr4Oid, SYM.net, link.opts.timing.sspReplyMs); } catch { /* fall through to text */ }
  }
  if (link.ls.net) return { ...link.ls.net };
  if (!link.hasTextChannel()) throw new Error('E_NO_NET: receiver did not report net over SSP (no text channel on this transport)');
  const q = async (k) => { try { const v = await link.text.query(k, { timeoutMs: link.opts.timing.responseMs, retries: 1 }); return v === null ? null : Number(v); } catch { return null; } };
  const net = { frequencyHz: await q('frequency'), timeslots: await q('ts'), slotMs: await q('sonde_slot_length'), sf: null, bw: null, cr: null, groundSlot: null, sampleMs: await q('sample_ms'), maxData: await q('max_data') };
  if (net.frequencyHz === null && net.timeslots === null) throw new Error('E_NO_NET: receiver did not answer net queries');
  link.ls.net = net;
  if (net.sampleMs) link.tele.sampleMs = net.sampleMs;
  return { ...net };
}
/**
 * Write settings: frequency/timeslots/sampling/slot length/max data via text (write-and-verify),
 * SF/BW/CR/ground slot via SSP `set net` with the complete struct in the negotiated schema, then
 * push the RR4's net to the S2 and verify by read-back (spec §5.4, §5.5).
 */
export async function writeNet(link, patch) {
  const text = link.text, tm = link.opts.timing;
  const textKeys = { frequencyHz: 'frequency', timeslots: 'ts', sampleMs: 'sample_ms', slotMs: 'sonde_slot_length', maxData: 'max_data' };
  const errors = [];
  if (patch.frequencyHz !== undefined && patch.frequencyHz !== null) checkFrequency(patch.frequencyHz, link.opts.freqRange);   // before anything is sent (3.11.8)
  const viaText = link.hasTextChannel();
  link.ls.net = null;                                    // read-back = the first net report/query after our writes
  if (viaText) {
    for (const [k, cmd] of Object.entries(textKeys)) {
      if (patch[k] === undefined || patch[k] === null) continue;
      try { await text.setting(cmd, Math.round(patch[k]), { timeoutMs: tm.responseMs }); } catch (e) { errors.push(e.message); }
    }
  }
  // Without a text channel (WiFi, spec §1.8) every field goes into the one SSP `set net` [I: Windsond only sets SF/BW/CR/ground slot this way]
  const sspKeys = viaText ? ['sf', 'bw', 'cr', 'groundSlot'] : ['sf', 'bw', 'cr', 'groundSlot', 'frequencyHz', 'timeslots', 'sampleMs', 'slotMs', 'maxData'];
  if (sspKeys.some((k) => patch[k] !== undefined && patch[k] !== null)) {
    if (!link.ssp || !link.ssp.joined || !link.ls.rr4Oid || !link.ls.netStruct) errors.push('E_SSP_NOT_JOINED: LoRa parameters need the SSP link');
    else {
      const struct = structFromNet({ ...netFromStruct(link.ls.netStruct), ...Object.fromEntries(sspKeys.filter((k) => patch[k] != null).map((k) => [k, patch[k]])) }, link.ls.netStruct);
      const schema = typeof link.ls.netSchema === 'number' ? link.ls.netSchema : ('netId' in link.ls.netStruct ? REF.NET_V5 : REF.NET_V6);
      link.ls.net = null;                                // the report that follows this set is the read-back (may arrive in the same tick as the reply)
      try { await link.ssp.set(link.ls.rr4Oid, new Map([[SYM.net, typedNet(schema, struct)]]), tm.sspReplyMs); } catch (e) { errors.push(e.message); }
    }
  }
  // read-back: the next net report (SSP) or the text queries must reflect the patch
  const net = await readNet(link);
  for (const k of Object.keys(patch)) if (patch[k] != null && net[k] != null && Math.round(net[k]) !== Math.round(patch[k])) errors.push(`E_SET_MISMATCH: ${k}=${net[k]} (wanted ${patch[k]})`);
  // 3.11.8: RR4 with sspDefaultSet syncs the S2 itself – refresh the default set instead of pushing to the S2
  if (link.ls.autoSync) { try { await syncDefaultSet(link); } catch (e) { errors.push(`sspDefaultSet: ${e.message}`); } }
  else if (link.ls.s2Oid) { try { await s2.pushNet(link); } catch (e) { errors.push(`S2: ${e.message}`); } }
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { net });
  return net;
}
/** "Pair with sond": `annNet` (spec §5.4; effect is [I], TODO spec §8 Q7). */
export async function pairSonde(link) {
  const r = await link.text.command('annNet', { timeoutMs: link.opts.timing.responseMs, retries: 1 });
  if (/^(Error|Failed)/i.test(r)) throw new Error(`E_RR4: ${r}`);
  return r;
}
/** `temp` → [temp=<°C>, pr=<Pa>], `bat` → [bat=<V>] or [<V>] (spec §5.4); errors leave the old values. */
export async function pollSensors(link) {
  const rx = link.ls.receiver; if (!rx) return;
  try {
    const r = await link.text.command('temp', { timeoutMs: link.opts.timing.responseMs });
    const t = /temp\s*=\s*(-?[\d.]+)/i.exec(r), p = /pr\s*=\s*(-?[\d.]+)/i.exec(r);
    if (t) rx.tempC = Number(t[1]); if (p) rx.pa = Number(p[1]);
    if (/^(Error|Failed)/i.test(r)) throw new Error(r);
    const b = await link.text.command('bat', { timeoutMs: link.opts.timing.responseMs });
    const m = /(?:bat\s*=\s*)?(-?[\d.]+)/i.exec(b);
    if (m && !/^(Error|Failed)/i.test(b)) rx.batV = Number(m[1]);
  } catch (e) { link.ls.sensorErrT = Date.now(); }
}
/** The receiver's own data arrives as bracket messages with role=6 (spec §4.2). */
export function onOwnTelemetry(link, p) {
  const rx = link.ls.receiver; if (!rx) return;
  if (p.lat !== undefined && p.lon !== undefined && !(p.lat === 0 && p.lon === 0) && p.lat !== null) { rx.lat = p.lat; rx.lon = p.lon; rx.gnssFix = true; }
  else if (p.sats !== undefined) rx.gnssFix = p.sats >= 4;
  if (p.alt !== undefined) rx.alt = p.alt; if (p.pa !== undefined) rx.pa = p.pa; if (p.su !== undefined) rx.batV = p.su;
  if (p.te !== undefined) rx.tempC = p.te; if (p.sats !== undefined) rx.sats = p.sats;
}
/** §5.7 A: collect GNSS aiding data from the RR4 (gnssGetAid until an empty Blob, ≤ 40 calls). */
export async function gnssGetAid(link, { maxCalls = 40 } = {}) {
  if (!link.ssp || !link.ssp.joined || !link.ls.rr4Oid) throw new Error('E_SSP_NOT_JOINED');
  const chunks = [];
  for (let i = 0; i < maxCalls; i++) {
    const b = plain(await link.ssp.call(link.ls.rr4Oid, SYM.gnssGetAid, null, link.opts.timing.aidReplyMs));
    if (!(b instanceof Uint8Array) || b.length === 0) break;
    chunks.push(b);
    link.progress({ phase: 'download', done: i + 1, total: maxCalls });
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (!total) throw new Error('E_NO_AID: receiver has no ephemeris');
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  link.ls.aid = { data: out, t: Date.now() };
  return out;
}
