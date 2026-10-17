// GroundLink – the hardware facade of docs/INTERFACE.md §3, composing serial, text protocol,
// SSP session, RR4/S2 procedures and the telemetry builder. The UI only imports this file.
// Nothing here blocks: every method is async with a timeout and rejects with an error whose
// message starts with a code (E_TIMEOUT, E_NO_SONDE, …) that the UI translates.

import { SerialLink } from './serial.js';
import { TextProto } from './text-proto.js';
import { SspSession, SYM } from './ssp-session.js';
import { TelemetryBuilder } from './telemetry.js';
import * as rr4 from './rr4.js';
import * as s2 from './s2.js';

export { parseBracketLine } from './lines.js';
export { encodeFrame, decodeFrame } from './ssp-bin.js';
export { SimGroundLink } from '../sim/sim-link.js';

export const DEFAULT_OPTIONS = {
  baudRate: 38400,                 // [C] RR4; 57600 for the SA1 cable (spec §1.1)
  usb: null,                       // {usbVendorId, usbProductId}: re-find the remembered port
  requireSsp: false,               // true → connect() fails when the SSP network is not joined in 10 s
  pollReceiverSensors: true,       // [C] text `temp`/`bat` polling (spec §1.6)
  pollSensorsMs: 3000,
  pushNetToS2: true,               // [C] copy RR4 net to the S2 when it appears (spec §5.3 step 5)
  S2_TRY_SSP_RELALT: false,        // [I] additionally `set relAlt` over SSP – TODO (spec §8 Q1/Q11)
  wiresViaExe: false,              // [C] `wires` is one-way (`.cmd=`); true = `.exe=` – TODO (spec §8 Q2)
  sondeTypeFromName: true,         // [U] derive "S2H3-R-B20" from an `S2_…` object name – TODO (spec §8 Q8)
  readFwVerStr: false,             // [I] read fwVerStr (345) over SSP – TODO (spec §8 Q8)
  lockSondeId: true,               // ignore telemetry of other sonde ids once one is seen
  relBalGroundMs: 150,             // [C] `relBal=150` on the ground (spec §5.8)
  beepHz: 2900,                    // [C]
  aidChunkBytes: 50,               // [C] ≤ 50 B per gnssCmd chunk – TODO verify (spec §8 Q13)
  aidCacheMs: 2 * 3600e3,          // reuse downloaded ephemeris for 2 h
  altMethod: 'isa',                // 'isa' | 'hypso' pressure altitude (telemetry.js)
  wireMinA: 0.2, battMinV: 3.6,    // wire-test thresholds – TODO (spec §8 Q2/Q9)
  timing: {
    textSpacingMs: 200, responseMs: 400, firstEchoMs: 2000, exeAckMs: 400, exeTimeoutMs: 8000, exeSpacingMs: 1000,
    sspReplyMs: 2000, nameReplyMs: 1500, aidReplyMs: 1500, joinTimeoutMs: 10000, keepAliveMs: 3000, pingReplyMs: 1000, probeMs: 3000,
    paramsWaitMs: 6000,
  },
};

export class GroundLink extends EventTarget {
  static isSupported() { return SerialLink.isSupported(); }

  constructor(opts = {}) {
    super();
    this.opts = { ...DEFAULT_OPTIONS, ...opts, timing: { ...DEFAULT_OPTIONS.timing, ...(opts.timing || {}) } };
    this.serial = null; this.text = null; this.ssp = null;
    this.tele = new TelemetryBuilder({ altMethod: this.opts.altMethod, wireMinA: this.opts.wireMinA, battMinV: this.opts.battMinV });
    this.known = new Map();          // oid → name (SSP objects)
    this._discovery = null;          // serialised component classification (rr4.onComponents)
    this.session = null;
    this._timers = [];
    this._resetLs();
  }
  _resetLs() { this.ls = { port: 'closed', receiver: null, sonde: null, net: null, netStruct: null, netSchema: null, rr4Oid: null, s2Oid: null, components: [], lastRxT: null, aid: null }; }

  // ---- lifecycle -----------------------------------------------------------------------------------
  /**
   * @param {{port?:object}|undefined} o  undefined → remembered port (or picker); {} → picker; {port} → that port.
   * Resolves with ReceiverInfo once the handshake succeeded (SSP join/discovery are best effort unless requireSsp).
   */
  async connect(o) {
    if (this.ls.port === 'open' || this.ls.port === 'opening') throw new Error('E_PORT_OPEN');
    this._resetLs(); this.known.clear();
    this.ls.port = 'opening'; this.emitState(true);
    const serial = new SerialLink({ textSpacingMs: this.opts.timing.textSpacingMs });
    try {
      let port = o && o.port ? o.port : null;
      if (!port && o === undefined) port = await SerialLink.rememberedPort(this.opts.usb);
      await serial.open({ port, baudRate: this.opts.baudRate, filters: this.opts.usb && this.opts.usb.usbVendorId ? [this.opts.usb] : null });
    } catch (e) { this.ls.port = 'closed'; this.emitState(); throw this._err(e.name === 'NotFoundError' ? new Error('E_NO_PORT: no port chosen') : e); }
    this.serial = serial;
    this.text = new TextProto(serial, { ...this.opts.timing });
    this.ssp = new SspSession(serial, { probeMs: this.opts.timing.probeMs, keepAliveMs: this.opts.timing.keepAliveMs, pingReplyMs: this.opts.timing.pingReplyMs, joinTimeoutMs: this.opts.timing.joinTimeoutMs });
    this._wire();
    try {
      const hs = await rr4.handshake(this);
      this.ls.receiver = { hw: hs.hw, fw: hs.fw, prot: hs.prot, mac: hs.mac, about: hs.about, product: hs.product, componentId: null, gnssFix: null, batV: null, tempC: null, utcSyncSource: null, gnssHasAid: null, sats: null, pa: null, lat: null, lon: null, alt: null, usb: serial.info };
      this.ls.port = 'open'; this.emitState(true);
      if (hs.sspCapable) {
        this._connectingSsp = true;                       // the 'joined' listener must not start a second discovery
        try { await this.ssp.start(); this._connectingSsp = false; await rr4.discover(this); }
        catch (e) { this._connectingSsp = false; if (this.opts.requireSsp) throw e; this.warn(`SSP: ${e.message}`); this._err(e); }
      }
      try { await rr4.readNet(this); } catch (e) { this.warn(e.message); }
      if (this.opts.pollReceiverSensors) this._timers.push(setInterval(() => { if (this.ls.port === 'open' && !this.text._inflight && !this.text._q.length) rr4.pollSensors(this); }, this.opts.pollSensorsMs));
      this.emitState();
      return { ...this.ls.receiver };
    } catch (e) {
      await this._teardown('closed');
      throw this._err(e);
    }
  }
  async disconnect() { await this._teardown('closed'); }
  async _teardown(portState) {
    this._timers.forEach(clearInterval); this._timers = [];
    if (this._stateTimer) { clearTimeout(this._stateTimer); this._stateTimer = null; }
    if (this.ssp) { if (this.ssp.joined && portState === 'closed') { try { await this.ssp.unsubAll(); } catch { /* ignore */ } } this.ssp.stop(); }
    if (this.text) this.text.dispose();
    if (this.serial) { try { await this.serial.close(); } catch { /* ignore */ } }
    this.ssp = null; this.text = null; this.serial = null;
    this.ls.port = portState; this.ls.rr4Oid = null; this.ls.s2Oid = null;
    this.emitState(true);
  }
  _wire() {
    const serial = this.serial, text = this.text, ssp = this.ssp;
    serial.addEventListener('line', (e) => {
      const d = e.detail;
      if (d.dir === 'rx') this.ls.lastRxT = d.t;
      this.dispatchEvent(new CustomEvent('line', { detail: { dir: d.dir, text: d.text, t: d.t } }));
    });
    serial.addEventListener('close', (e) => { if (e.detail.reason !== 'closed' && this.ls.port !== 'closed') { this._teardown('lost'); this._err(new Error(`E_PORT_LOST: ${e.detail.reason}`)); } });
    serial.addEventListener('error', (e) => this.warn(`serial: ${e.detail && e.detail.message}`));
    text.addEventListener('message', (e) => this._message(e.detail));
    ssp.addEventListener('joined', () => { this.ls.components = []; this.known.clear(); if (this.ls.receiver) this.ls.receiver.sspId = ssp.id; this.emitState(); });
    ssp.addEventListener('lost', (e) => { this.ls.rr4Oid = null; s2.detach(this); this.known.clear(); this.warn(`SSP link lost: ${e.detail.reason}`); this.emitState(); });
    ssp.addEventListener('report', (e) => this._report(e.detail));
    ssp.addEventListener('warn', (e) => this.warn(`SSP frame: ${e.detail.error && e.detail.error.message}`));
    // (re)discover after a (re)join – except for the join that connect() itself is waiting for
    ssp.addEventListener('joined', () => { if (this._connectingSsp) return; rr4.discover(this).catch((err) => this.warn(err.message)); });
  }
  _report({ oid, values }) {
    if (oid === (this.ssp.central ?? 1) && values.has(SYM.components)) rr4.onComponents(this, values.get(SYM.components)).catch((e) => this.warn(e.message));
    if (oid === this.ls.rr4Oid) rr4.onReport(this, values);
    if (oid === this.ls.s2Oid) s2.onReport(this, values);
    this.emitState();
  }
  _message(msg) {
    const t = msg.t ?? Date.now();
    try {
      if (msg.type === 'DAT' || msg.type === 'MET') {
        if (msg.role === 6) { rr4.onOwnTelemetry(this, msg.params); this.emitState(); return; }
        s2.onTelemetry(this, msg.params, t);
        if (this.opts.lockSondeId && this.ls.sonde && this.ls.sonde.id !== null && msg.id !== null && msg.id !== this.ls.sonde.id) return;
        const pk = this.tele.packet(msg, t);
        if (pk) this.dispatchEvent(new CustomEvent('packet', { detail: pk }));
        for (const rec of this.tele.records(msg, t)) {
          if (this.ls.sonde && rec.altAgl !== null) this.ls.sonde.agl = rec.altAgl;
          this.dispatchEvent(new CustomEvent('telemetry', { detail: rec }));
        }
        return;
      }
      if (msg.type === 'PK') { const pk = this.tele.packet(msg, t); if (pk) this.dispatchEvent(new CustomEvent('packet', { detail: pk })); return; }
      const ev = this.tele.event(msg, t);
      if (ev) {
        if (ev.type === 'announce' && ev.data.id !== null) s2.onTelemetry(this, msg.params, t);
        if (ev.type === 'cutdown' && this.ls.sonde) this.ls.sonde.md = 7;
        this.dispatchEvent(new CustomEvent('event', { detail: ev }));
      }
    } catch (e) { this.warn(`message ${msg.type}: ${e.message}`); }
  }

  // ---- state ---------------------------------------------------------------------------------------
  get state() {
    const l = this.ls;
    return {
      port: l.port,
      receiver: l.receiver ? { ...l.receiver } : null,
      sonde: l.sonde && l.sonde.id !== null ? { ...l.sonde, conditionText: [...(l.sonde.conditionText || [])] } : null,
      net: l.net ? { ...l.net } : null,
      lastRxT: l.lastRxT, rxLines: this.serial ? this.serial.rxLines : 0, txLines: this.serial ? this.serial.txLines : 0,
      ssp: this.ssp ? { joined: this.ssp.joined, id: this.ssp.id, central: this.ssp.central, components: [...l.components], rr4Oid: l.rr4Oid, s2Oid: l.s2Oid } : null,
    };
  }
  /** 'state' events are coalesced (≤ 1 per 250 ms, trailing) – SSP reports and role=6 lines arrive every second. */
  emitState(force = false) {
    const now = Date.now();
    if (force && this._stateTimer) { clearTimeout(this._stateTimer); this._stateTimer = null; }
    if (force || now - (this._stateT || 0) >= 250) { this._stateT = now; this.dispatchEvent(new CustomEvent('state', { detail: this.state })); return; }
    if (!this._stateTimer) this._stateTimer = setTimeout(() => { this._stateTimer = null; this._stateT = Date.now(); this.dispatchEvent(new CustomEvent('state', { detail: this.state })); }, 250);
  }
  /** Raw line ring buffer (last 2000 lines, {dir, text, t}) for the expert view / .sounding. */
  get lines() { return this.serial ? this.serial.lines : []; }
  warn(text) { this.dispatchEvent(new CustomEvent('warn', { detail: text })); if (typeof console !== 'undefined' && this.opts.verbose) console.warn('[GroundLink]', text); }
  progress(detail) { this.dispatchEvent(new CustomEvent('progress', { detail })); }
  _err(e) { const err = e instanceof Error ? e : new Error(String(e)); this.dispatchEvent(new CustomEvent('error', { detail: err })); return err; }
  _need() { if (this.ls.port !== 'open' || !this.text) throw new Error('E_PORT_CLOSED'); }
  async _run(fn) { this._need(); try { return await fn(); } catch (e) { throw this._err(e); } }

  // ---- receiver (RR4) ------------------------------------------------------------------------------
  readNet() { return this._run(() => rr4.readNet(this)); }
  writeNet(patch) { return this._run(() => rr4.writeNet(this, patch || {})); }
  pairSonde() { return this._run(() => rr4.pairSonde(this)); }
  /** Ephemeris RR4 → S2 (spec §5.7 A + upload); 'progress' events {phase, done, total}. */
  gnssAidToSonde() {
    return this._run(async () => {
      let data = this.ls.aid && Date.now() - this.ls.aid.t < this.opts.aidCacheMs ? this.ls.aid.data : null;
      if (!data) data = await rr4.gnssGetAid(this);
      return s2.gnssAidToSonde(this, data);
    });
  }

  // ---- sonde (S2) ----------------------------------------------------------------------------------
  readSonde() { return this._run(() => s2.readSonde(this)); }
  setCutdownAltitude(mAgl, groundPa) { return this._run(() => s2.setCutdownAltitude(this, mAgl, groundPa)); }
  setMode(n) { return this._run(() => s2.setMode(this, n)); }
  ledAndWireTest() { return this._run(() => s2.ledAndWireTest(this)); }
  cutdown() { return this._run(() => s2.cutdown(this)); }
  cutdownSecondary() { return this._run(() => s2.cutdownSecondary(this)); }
  beep() { return this._run(() => s2.beep(this)); }
  sendExe(text, o = {}) { return this._run(() => s2.sendExe(this, text, o)); }

  // ---- session -------------------------------------------------------------------------------------
  startSession({ groundAlt, groundPa, meta } = {}) { this.session = { groundAlt, groundPa, meta: meta || {} }; this.tele.startSession({ groundAlt, groundPa }); }
  stopSession() { this.session = null; this.tele.stopSession(); }
}
