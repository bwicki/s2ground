// SimGroundLink – the GroundLink facade (docs/INTERFACE.md §3) without hardware.
// Scripted, deterministic ascent from Rümlang: GPS-fix wait → ready → (release) → launch →
// ascent at ~2.5 m/s with wind turning with height → cutdown at the configured altitude →
// descent → landed. One TelemetryRecord per simulated second; `speed` scales wall-clock time.
// The protocol task re-exports this class from src/protocol/index.js as a GroundLink subclass;
// the UI never depends on the sim beyond the shared facade API.

import { isaPressure, dewPoint, altFromPressure, destPoint, distanceM } from '../util/format.js';

/** Small deterministic PRNG (mulberry32) so tests and demos repeat exactly. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODES = { init: 0, ready: 1, rising: 2, falling: 3, resting: 4, findme: 5, cutdown: 7 };

export class SimGroundLink extends EventTarget {
  static isSupported() { return true; }

  /**
   * @param {object} o  speed (1 = real time), seed, start {lat,lon,alt}, cutAltAgl, gpsFixS,
   *                    launchDelayS, lostSignal (true → no packets below 1'230 m AGL in the
   *                    descent until 90 s after landing: the "position uncertain" variant)
   */
  constructor(o = {}) {
    super();
    this.opt = { speed: 1, seed: 42, start: { lat: 47.4433, lon: 8.5617, alt: 432 }, cutAltAgl: 1600, gpsFixS: 25, launchDelayS: 6, lostSignal: false, sondeId: 123, ...o };
    this.rand = rng(this.opt.seed);
    this.simT = 0;                   // simulated seconds since connect
    this.phase = 'off';              // off | gpsWait | ready | launchWait | rising | cutting | falling | landed
    this.seq = 0; this.rx = 0; this.tx = 0;
    this.sats = 0;
    this.pos = { ...this.opt.start };
    this.rise = 0; this.spd = 0; this.ang = 0;
    this.su = 4.10;
    this.cutAltAgl = this.opt.cutAltAgl;
    this.session = null;             // {groundAlt, groundPa}
    this.timer = null;
    this.lastRxT = null;
    this.launchedAt = null; this.cutAt = null; this.landedAt = null;
    this.pendingCut = false;
    this.cutBy = null;
  }

  // ---- lifecycle ---------------------------------------------------------------------------
  async connect() {
    this.phase = 'gpsWait';
    this.port = 'opening'; this.t0 = Date.now();
    this._emitState();
    await this._sleep(300);
    this.port = 'open';
    this._line('tx', 'echo=0'); this._line('rx', '[echo=0]');
    this._line('tx', 'about'); this._line('rx', '[about="Sparv RR4 hw=4, fw=1.4.2, prot=6"] (SIM)');
    this._emitState();
    this._emitEvent('announce', { id: this.opt.sondeId });
    this._start();
    return this.state.receiver;
  }
  async disconnect() { this._stop(); this.port = 'closed'; this.phase = 'off'; this._emitState(); }

  get state() {
    const agl = this.pos.alt - this.opt.start.alt;
    return {
      port: this.port || 'closed',
      receiver: this.port === 'open' ? { hw: '4', fw: '1.4.2', prot: 6, mac: '1F3A', componentId: 1, gnssFix: true, batV: 4.05, tempC: 21.5, utcSyncSource: 'gnss', sats: 11, pa: this._groundPa() } : null,
      sonde: this.phase === 'off' ? null : {
        id: this.opt.sondeId, name: 'S2', componentId: 2, type: 'S2H3-R-B20', md: this._md(), batV: this.su, pr: this._pa(),
        condition: this.sats < 5 ? 1 << 18 : 0, conditionText: this.sats < 5 ? ['no GPS fix'] : [], powerDbm: this.phase === 'gpsWait' || this.phase === 'ready' ? 0 : 13,
        powerBeforeLaunchDbm: 0, txCriterion: 1, fwver: '3.1', cutAltAgl: this.cutAltAgl, role: 1, sats: this.sats, agl,
      },
      net: { frequencyHz: 433900000, timeslots: 1, slotMs: 1000, sf: 9, bw: 125000, cr: 5, groundSlot: 0, sampleMs: 1000, maxData: 200 },
      lastRxT: this.lastRxT, rxLines: this.rx, txLines: this.tx,
    };
  }

  // ---- receiver ----------------------------------------------------------------------------
  async readNet() { return this.state.net; }
  async writeNet(patch) { this._line('tx', `set net ${JSON.stringify(patch)}`); return { ...this.state.net, ...patch }; }
  async pairSonde() { this._line('tx', 'annNet'); }
  async gnssAidToSonde() {
    for (let i = 1; i <= 4; i++) { await this._sleep(150); this.dispatchEvent(new CustomEvent('progress', { detail: { done: i, total: 4 } })); }
    this.sats = Math.max(this.sats, 4);
  }

  // ---- sonde -------------------------------------------------------------------------------
  async readSonde() { await this._sleep(200); return this.state.sonde; }
  async setCutdownAltitude(mAgl) {
    this._line('tx', `${this.opt.sondeId}.exe=relAP=${Math.round(isaPressure(this.opt.start.alt + mAgl) / 2)}:${mAgl}`);
    await this._sleep(600);
    this.cutAltAgl = mAgl;
    this._line('rx', `[#RES:q=64:OK]`); this._line('rx', `[#DAT:id=${this.opt.sondeId},cutalt=${mAgl}]`);
    return mAgl;                       // read-back value
  }
  async setMode(n) { this._line('tx', `${this.opt.sondeId}.exe=mode=${n}`); await this._sleep(300); if (n === MODES.findme) this.findme = true; }
  async ledAndWireTest() {
    this._line('tx', `${this.opt.sondeId}.cmd=wires`);
    await this._sleep(1500);
    const raw = '[#TXT:id=123:R(S57B411C0L1)]';
    this._line('rx', raw);
    const data = { primaryOk: true, secondaryOk: false, ledOk: true, battOk: true, raw };
    this._emitEvent('wireTest', data, raw);
    return data;
  }
  async cutdown() {
    const inFlight = this.phase === 'rising';
    this._line('tx', `${this.opt.sondeId}.exe=${inFlight ? 'relBal' : 'relBal=150'}`);
    await this._sleep(800);
    this._line('rx', '[#RES:q=70:Burning]');
    if (inFlight) { this.pendingCut = true; this.cutBy = 'manual'; }
    return 'Burning';
  }
  async cutdownSecondary() { this._line('tx', `${this.opt.sondeId}.exe=relGnd`); await this._sleep(800); return 'OK'; }
  async beep() { this._line('tx', `${this.opt.sondeId}.exe=beep=2900`); await this._sleep(300); return 'OK'; }
  async sendExe(text) { this._line('tx', `${this.opt.sondeId}.exe=${text}`); await this._sleep(500); const r = `[#RES:q=64:OK ${text}]`; this._line('rx', r); return 'OK'; }

  // ---- session -----------------------------------------------------------------------------
  startSession({ groundAlt, groundPa } = {}) { this.session = { groundAlt: groundAlt ?? this.opt.start.alt, groundPa: groundPa ?? this._groundPa() }; }
  stopSession() { this.session = null; }

  // ---- sim-only controls (not part of the GroundLink API) ----------------------------------
  /** "START FREIGEBEN": the sonde launches launchDelayS later (the crew lets go). */
  release() { if (this.phase === 'ready') { this.phase = 'launchWait'; this.releaseT = this.simT; } }
  setSpeed(s) { this.opt.speed = s; if (this.timer) this._start(); }
  /** Simulated clock (ms since epoch): wall time at connect + simulated seconds. */
  now() { return (this.t0 || Date.now()) + this.simT * 1000; }
  /** Advance the simulation by n seconds synchronously (tests). */
  advance(n = 1) { for (let i = 0; i < n; i++) this.tick(); }

  // ---- internals ---------------------------------------------------------------------------
  _start() { this._stop(); this.timer = setInterval(() => this.tick(), Math.max(20, 1000 / this.opt.speed)); }
  _stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  _sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(5, ms / this.opt.speed))); }
  _groundPa() { return 96240; }       // 962.4 hPa at 432 m (design board value)
  _pa() { return Math.round(isaPressure(this.pos.alt) * (this._groundPa() / isaPressure(this.opt.start.alt))); }
  _md() {
    return { off: 0, gpsWait: 0, ready: 1, launchWait: 1, rising: 2, cutting: 7, falling: 3, landed: this.findme ? 5 : 4 }[this.phase];
  }
  _emitState() { this.dispatchEvent(new CustomEvent('state', { detail: this.state })); }
  _emitEvent(type, data, raw = '') { this.dispatchEvent(new CustomEvent('event', { detail: { type, data, raw } })); }
  _line(dir, text) {
    if (dir === 'rx') { this.rx++; this.lastRxT = this.now(); } else this.tx++;
    this.dispatchEvent(new CustomEvent('line', { detail: { dir, text, t: this.now() } }));
  }

  /** Wind at altitude for the sim: from 230° at ground veering to ~260° at 3 km, strengthening. */
  _wind(alt) {
    const agl = Math.max(0, alt - this.opt.start.alt);
    return { dir: (230 + agl / 100) % 360, spd: 2 + agl / 250 };
  }
  _temp(alt) {
    const agl = alt - this.opt.start.alt;
    let t = 12.3 - 0.0065 * agl;
    if (agl > 700 && agl < 850) t += 3.5 * ((agl - 700) / 150);    // inversion 1'150–1'300 m AMSL (+2.5 K net)
    else if (agl >= 850 && agl < 1000) t += 3.5 * (1 - (agl - 850) / 150);
    return t;
  }
  _rh(alt) {
    const agl = alt - this.opt.start.alt;
    if (agl > 700 && agl < 1000) return 95 + this.rand() * 2;        // cloud band
    return Math.max(30, 71 - agl / 60 + (this.rand() - 0.5) * 2);
  }

  /** One simulated second. */
  tick() {
    this.simT += 1;
    const noise = () => (this.rand() - 0.5);
    const groundAlt = this.opt.start.alt;
    switch (this.phase) {
      case 'gpsWait':
        this.sats = Math.min(9, Math.floor((this.simT / this.opt.gpsFixS) * 9));
        if (this.simT >= this.opt.gpsFixS) { this.phase = 'ready'; this.sats = 9; this._emitState(); }
        break;
      case 'launchWait':
        if (this.simT - this.releaseT >= this.opt.launchDelayS) { this.phase = 'rising'; this.launchedAt = this.simT; this._emitState(); }
        break;
      case 'rising': {
        this.rise = 2.5 + noise() * 0.6;
        this.pos.alt += this.rise;
        this._drift();
        if (this.pendingCut || (this.cutAltAgl != null && this.pos.alt - groundAlt >= this.cutAltAgl)) {
          this.phase = 'cutting'; this.cutAt = this.simT; this.cutBy = this.cutBy || 'auto'; this.pendingCut = false;
          const raw = `[#TXT:id=${this.opt.sondeId}:C(A${Math.round(this.pos.alt - groundAlt)}T${this.simT})]`;
          this._line('rx', raw);
          this._emitEvent('cutdown', { alt: this.pos.alt, altAgl: this.pos.alt - groundAlt, by: this.cutBy }, raw);
          this._emitState();
        }
        break;
      }
      case 'cutting':
        this.rise = 0.5 + noise();
        this.pos.alt += this.rise; this._drift();
        if (this.simT - this.cutAt >= 2) { this.phase = 'falling'; this._emitEvent('wireHeated', {}, '[#TXT:id=123:w(1)]'); this._emitState(); }
        break;
      case 'falling': {
        const rho = Math.pow(1 - this.pos.alt / 44330, 4.2559);
        this.rise = -(5 / Math.sqrt(rho)) + noise();
        this.pos.alt += this.rise; this._drift();
        if (this.pos.alt <= groundAlt - 20) {                          // landed 20 m below the launch field
          this.pos.alt = groundAlt - 20; this.phase = 'landed'; this.landedAt = this.simT; this.rise = 0; this.spd = 0;
          this._emitState();
        }
        break;
      }
      default: break;
    }
    if (this.phase === 'off') return;
    this.su = Math.max(3.6, 4.10 - this.simT / 20000);
    // packet cadence: 1/s in flight and on the ground before launch, 1/5 s after landing
    const cadence = this.phase === 'landed' ? 5 : 1;
    if (this.simT % cadence !== 0) return;
    this.seq++;
    if (this.seq % 97 === 0) return;                                   // deterministic packet loss
    if (this.opt.lostSignal && this.phase === 'falling' && this.pos.alt - groundAlt < 1230) return;
    if (this.opt.lostSignal && this.phase === 'landed' && this.simT - this.landedAt < 90) return;
    this._emitTelemetry();
  }

  _drift() {
    const w = this._wind(this.pos.alt);
    this.spd = w.spd + (this.rand() - 0.5) * 0.4;
    this.ang = (w.dir + 180 + (this.rand() - 0.5) * 4) % 360;
    const p = destPoint(this.pos.lat, this.pos.lon, this.ang, this.spd);
    this.pos.lat = p.lat; this.pos.lon = p.lon;
  }

  _emitTelemetry() {
    const hasFix = this.sats >= 5;
    const pa = this._pa();
    const te = +(this._temp(this.pos.alt) + (this.rand() - 0.5) * 0.2).toFixed(2);
    const hu = +Math.min(100, this._rh(this.pos.alt)).toFixed(2);
    const dist = distanceM(this.opt.start.lat, this.opt.start.lon, this.pos.lat, this.pos.lon);
    const slant = Math.hypot(dist, this.pos.alt - this.opt.start.alt);
    const rs = Math.round(-62 - 10 * Math.log10(1 + slant / 100) * 1.5 - (this.phase === 'landed' ? 25 : 0));
    const snr = Math.round(9 - slant / 1000 + (this.rand() - 0.5) * 2);
    const gpsAlt = hasFix ? +(this.pos.alt + (this.rand() - 0.5) * 6).toFixed(1) : null;
    const parts = [`id=${this.opt.sondeId}`, `seq=${this.seq}`, `md=${this._md()}`];
    if (hasFix) parts.push(`lat=${this.pos.lat.toFixed(6)}`, `lon=${this.pos.lon.toFixed(6)}`, `alt=${gpsAlt}`);
    parts.push(`pa=${pa}`, `te=${te.toFixed(2)}`, `hu=${hu.toFixed(2)}`);
    if (hasFix) parts.push(`spd=${this.spd.toFixed(2)}`, `ang=${this.ang.toFixed(2)}`);
    parts.push(`rise=${this.rise.toFixed(2)}`, `su=${this.su.toFixed(2)}`, `rs=${rs}`, `snr=${snr}`, `sats=${this.sats}`, `rec=0`);
    const raw = `[#DAT:${parts.join(',')}]`;
    this._line('rx', raw);
    const groundAlt = this.session ? this.session.groundAlt : null;
    const groundPa = this.session ? this.session.groundPa : null;
    const alt = this.session ? altFromPressure(pa, groundPa, groundAlt) : gpsAlt;
    const rec = {
      t: this.now(), sondeId: this.opt.sondeId, seq: this.seq, src: 'SIM', md: this._md(),
      lat: hasFix ? this.pos.lat : null, lon: hasFix ? this.pos.lon : null, gpsAlt,
      pa, alt: alt === null ? null : +alt.toFixed(1), altAgl: alt !== null && groundAlt !== null ? +(alt - groundAlt).toFixed(1) : null,
      te, hu, td: dewPoint(te, hu), spd: hasFix ? +this.spd.toFixed(2) : null, ang: hasFix ? +this.ang.toFixed(2) : null,
      rise: +this.rise.toFixed(2), su: +this.su.toFixed(2), rssi: Math.max(0, Math.min(1, (rs + snr + 140) / 90)), rs, snr, rec: 0, sats: this.sats,
      tei: +(22 + (this.rand() - 0.5)).toFixed(2), simT: this.simT, raw,
    };
    this.dispatchEvent(new CustomEvent('packet', { detail: { rssi: rec.rssi, rs, snr, rec: 0, t: rec.t } }));
    this.dispatchEvent(new CustomEvent('telemetry', { detail: rec }));
  }
}
