// SSP network session over the serial line (spec §1.5, §1.6, §2, §5.2): join the RR4's network
// (CInfo probe → NewId[WithRev] → ack), ticketed requests with timeouts, keep-alive pings,
// subscription bookkeeping, report routing and reconnect. Device-specific procedures (what to
// subscribe, how to read `net`) live in rr4.js / s2.js – this file only knows frames.

import { encodeFrame, decodeFrame, plain, asNameMap, Sym, Typed, NACK_TEXT, REF, T } from './ssp-bin.js';

export const LINK_ID = 0xff, CENTRAL_ID = 1;
export const SYM = { id: 4, name: 5, components: 13, utc: 17, ping: 24, fwVerStr: 345, bat: 314, condition: 336, sspDefaultSet: 477, samplingInterval: 503,
  gnssEnabled: 587, gnssCmd: 594, gnssSignals: 596, gnssGetAid: 598, gnssHasAid: 599, gnssEnabledConstellations: 628, jammingDetection: 630, spoofingDetection: 631, utcSyncSource: 774,
  pr: 890, prCalOf: 891, md: 1100, burn: 1102, relPr: 1103, burnTest: 1104, relAlt: 1105, landedBehavior: 1106, ledTest: 1107, role: 1109,
  mac: 1200, net: 1201, power_dBm: 1203, txCriterion: 1226, encKey: 1235, powerBeforeLaunch_dBm: 1239, encUnlocked: 1241, radioNoise: 1242,
  // 3.11.8 WiFi configuration of the RR4 (spec §1.8)
  wifiClientSsid: 1500, wifiClientPwd: 1501, wifiApSsid: 1502, wifiApPwd: 1503, wifiAp: 1504, ipAddr: 1505, wifiApply: 1506, wifiEnabled: 1507 };

export class SspSession extends EventTarget {
  /**
   * @param {import('./serial.js').SerialLink|import('./websocket-link.js').WebSocketLink} serial  any object with writeSsp(hex) and 'line' events
   * @param {{probeMs?:number, keepAliveMs?:number, pingReplyMs?:number, joinTimeoutMs?:number, name?:string, serial?:number, compat?:number, now?:()=>number}} opts
   *   compat: CInfo compatibility byte – 3 as sent by Windsond 3.11.8 (bit0 newidWithRev, bit1 "working get values"), 1 = 3.8.0 (spec §2.2)
   */
  constructor(serial, opts = {}) {
    super();
    this.serial = serial;
    this.opts = { probeMs: 3000, keepAliveMs: 3000, pingReplyMs: 1000, joinTimeoutMs: 10000, name: 'python', serial: 1, compat: 3, now: () => Date.now(), ...opts };
    if (typeof serial.probeMs === 'number') this.opts.probeMs = serial.probeMs;   // WebSocket link probes every 2 s (spec §1.8)
    this.id = 0; this.central = null; this.prio = 0;
    this.joined = false; this.running = false;
    this.pending = new Map();                 // tk → {resolve, reject, timer, name}
    this.subs = new Map();                    // oid → Set(sym)
    this.lastRxT = 0; this._nextTk = 1; this._pingPending = false;
    this.stats = { rx: 0, tx: 0, bad: 0, nacks: 0 };
    this._onLine = (e) => { if (e.detail.dir === 'rx' && e.detail.kind === 'ssp') this._frame(e.detail.hex, e.detail.t); };
    serial.addEventListener('line', this._onLine);
  }

  // ---- lifecycle -----------------------------------------------------------------------------------
  /** Start probing; resolves with {id, central} on the first join, rejects E_SSP_JOIN_TIMEOUT (probing continues). */
  start() {
    this.running = true;
    this._timer = setInterval(() => this._tick(), 500);
    this._probeT = 0;
    this._tick();
    return this.waitJoined(this.opts.joinTimeoutMs);
  }
  waitJoined(ms) {
    if (this.joined) return Promise.resolve({ id: this.id, central: this.central });
    return new Promise((resolve, reject) => {
      const h = (e) => { clearTimeout(tm); this.removeEventListener('joined', h); resolve(e.detail); };
      const tm = setTimeout(() => { this.removeEventListener('joined', h); reject(new Error('E_SSP_JOIN_TIMEOUT')); }, ms);
      this.addEventListener('joined', h);
    });
  }
  stop() {
    this.running = false; clearInterval(this._timer);
    this.serial.removeEventListener('line', this._onLine);
    this._forget('stopped', true);
  }
  /** Unsubscribe everything we subscribed (graceful close, spec §5.12); best effort. */
  async unsubAll() {
    for (const [oid, set] of this.subs) { try { await this.unsub(oid, [...set]); } catch { /* ignore */ } }
    this.subs.clear();
  }

  _tick() {
    if (!this.running) return;
    const now = this.opts.now();
    if (!this.joined) {
      if (now >= this._probeT) { this._probeT = now + this.opts.probeMs + Math.random() * 250; this._probe(); }
      return;
    }
    // keep-alive: no SSP traffic for keepAliveMs → ping; failure = link lost (spec §1.6)
    if (now - this.lastRxT >= this.opts.keepAliveMs && !this._pingPending) {
      this._pingPending = true;
      this.ping(this.opts.pingReplyMs).catch(() => this._forget('ping failed')).finally(() => { this._pingPending = false; });
    }
  }
  _probe() {
    // CInfo constants per spec §2.2: ver 3, magic 0xA6, serial 1, prio 0, compat 3 (3.11.8; 1 in 3.8.0)
    this._send({ to: LINK_ID, name: 'cinfo', body: { ver: 3, magicByte: 0xa6, tk: 0, serial: this.opts.serial, id: 0, parent: 0, prio: 0, componentType: 0, compatibility: this.opts.compat, name: this.opts.name } });
  }
  _forget(reason, silent = false) {
    const was = this.joined && !silent;
    this.joined = false; this.id = 0; this.central = null; this.subs.clear();
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`E_SSP_LOST: ${reason}`)); }
    this.pending.clear();
    this._probeT = 0;
    if (was) this.dispatchEvent(new CustomEvent('lost', { detail: { reason } }));
  }

  // ---- sending -------------------------------------------------------------------------------------
  _send(msg) {
    const hex = encodeFrame(msg);
    this.stats.tx++;
    return this.serial.writeSsp(hex);
  }
  _ticket() {
    for (let i = 0; i < 250; i++) {
      const tk = this._nextTk; this._nextTk = (this._nextTk % 250) + 1;
      if (!this.pending.has(tk)) return tk;
    }
    throw new Error('E_SSP_NO_TICKET');
  }
  /** Ticketed request; resolves with the reply's `b` (raw, may contain Typed), rejects E_NACK/E_TIMEOUT. */
  request(to, name, body, timeoutMs = 2000, { resolveOnAck = false } = {}) {
    if (!this.joined) return Promise.reject(new Error('E_SSP_NOT_JOINED'));
    const tk = this._ticket();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(tk); reject(new Error(`E_TIMEOUT: SSP ${name} to ${to} (tk ${tk})`)); }, timeoutMs);
      this.pending.set(tk, { resolve, reject, timer, name, resolveOnAck });
      this._send({ to, name, ticketed: true, body: { from: this.id, tk, ...body } }).catch((e) => { clearTimeout(timer); this.pending.delete(tk); reject(e); });
    });
  }
  async uget(oid, syms, timeoutMs = 1500) {
    const b = await this.request(oid, 'uget', { var: syms }, timeoutMs);
    const list = plain(b);
    if (!Array.isArray(list)) throw new Error('E_SSP_DATA: uget reply is not a list');
    return list;
  }
  /** → [{schema, settable}] in symbol order (spec §2.1: list of (Schema, U8) tuples, REF96/99 or List). */
  async getVarType(oid, syms, timeoutMs = 2000) {
    const b = await this.request(oid, 'getVarType', { sym: syms }, timeoutMs);
    const list = b instanceof Typed ? b.value : b;
    if (!Array.isArray(list)) throw new Error('E_SSP_DATA: getVarType reply is not a list');
    return list.map((t) => { const tup = t instanceof Typed ? t.value : t; return { schema: tup[0] instanceof Typed ? tup[0].value : tup[0], settable: !!plain(tup[1]) }; });
  }
  set(oid, map, timeoutMs = 2000) { return this.request(oid, 'set', { map }, timeoutMs); }
  call(oid, sym, arg = null, timeoutMs = 2000, o = {}) { return this.request(oid, 'call', { sym, arg }, timeoutMs, o); }
  /** Non-ticketed call (spec §2.1 code 14) – used for nothing in Windsond; kept for experiments. */
  callNoReply(oid, sym, arg = null) { return this._send({ to: oid, name: 'call', body: { sym, arg } }); }
  async sub(oid, syms) {
    if (!this.joined) throw new Error('E_SSP_NOT_JOINED');
    await this._send({ to: oid, name: 'sub', body: { from: this.id, sym: syms } });
    if (!this.subs.has(oid)) this.subs.set(oid, new Set());
    syms.forEach((s) => this.subs.get(oid).add(s));
  }
  async unsub(oid, syms) {
    if (!this.joined) return;
    await this._send({ to: oid, name: 'unsub', body: { from: this.id, sym: syms } });
    if (this.subs.has(oid)) syms.forEach((s) => this.subs.get(oid).delete(s));
  }
  /** Keep-alive: call ping(24) on the neighbour with our id as argument (spec §1.6). */
  ping(timeoutMs = this.opts.pingReplyMs) { return this.call(this.central ?? CENTRAL_ID, SYM.ping, this.id, timeoutMs); }

  // ---- receiving -----------------------------------------------------------------------------------
  _frame(hex, t) {
    let f;
    try { f = decodeFrame(hex); }
    catch (e) { this.stats.bad++; this.dispatchEvent(new CustomEvent('warn', { detail: { hex, error: e } })); return; }
    this.stats.rx++; this.lastRxT = t ?? this.opts.now();
    this.dispatchEvent(new CustomEvent('frame', { detail: f }));
    try { this._route(f); }
    catch (e) { this.dispatchEvent(new CustomEvent('warn', { detail: { hex, error: e } })); }
  }
  _route(f) {
    const b = f.body;
    switch (f.name) {
      case 'newid':
      case 'newidWithRev': {
        // NewId addressed to the link (0xFF) or to us; tk = central's id (spec §5.2)
        if (f.to !== LINK_ID && f.to !== this.id) return;
        if (f.name === 'newidWithRev') this._send({ to: LINK_ID, name: 'newidAck', body: { revision: b.revision } });
        const rejoin = this.joined && (this.id !== b.id || this.central !== b.tk);
        if (rejoin) this._forget('re-assigned id');
        this.id = b.id; this.central = b.tk; this.prio = b.prio;
        if (!this.joined) { this.joined = true; this.dispatchEvent(new CustomEvent('joined', { detail: { id: this.id, central: this.central, name: b.name } })); }
        return;
      }
      case 'reply': case 'ack': case 'nack': {
        const p = this.pending.get(b.tk);
        if (!p) return;                                               // late reply – ticket already timed out
        if (f.name === 'ack' && !p.resolveOnAck) return;              // partial result, final reply follows (spec §2.1)
        clearTimeout(p.timer); this.pending.delete(b.tk);
        if (f.name === 'nack') { this.stats.nacks++; p.reject(Object.assign(new Error(`E_NACK: ${p.name} → ${b.code} ${NACK_TEXT[b.code] || ''}`.trim()), { code: b.code })); }
        else p.resolve(b.b);
        return;
      }
      case 'rep': {
        for (const [oid, any] of b.map) {
          let values;
          try { values = asNameMap(any); } catch (e) { this.dispatchEvent(new CustomEvent('warn', { detail: { error: e } })); continue; }
          this.dispatchEvent(new CustomEvent('report', { detail: { oid, values, raw: any } }));
        }
        return;
      }
      case 'wentoffline':
        this.dispatchEvent(new CustomEvent('offline', { detail: { ids: plain(b.ids) } }));
        return;
      default: return;                                                // cinfo/call/sub addressed to us: not handled
    }
  }
}

/** Helper: build the value for `set net` with the schema the device reported (REF105/102, spec §3.3). */
export function typedNet(schemaRegIx, net) { return new Typed(schemaRegIx ?? REF.NET_V6, net); }
export { Sym, Typed, T };
