// Bracket messages → TelemetryRecord (docs/INTERFACE.md §2) and link events (spec §5.10, §6).
// DAT/MET become records; MET history samples (spd1…9, ang1…9, te1…9, hu1…9) are expanded into
// INF records spaced by the sampling interval with the pressure interpolated from the previous
// packet that carried pressure (≤ 22 s old) – exactly what the original software does, so the
// resulting .raw_flight_history.csv is compatible with s2stueve.

import { altFromPressure, dewPoint, isaAltitude } from '../util/format.js';
import { rssiFromParams, parseTxtData } from './lines.js';

const R_D = 287.05, G0 = 9.80665;
const num = (v) => (v === undefined || v === null || Number.isNaN(v) ? null : v);

/**
 * Wire/LED test report `R(S<n>B<n>C<n>L<n>…)` (spec §5.8). Letters: S primary wire, C secondary
 * wire, B battery, L LED; S/C are currents in 1/100 A. Thresholds are *ours* – the GUI's exact
 * numbers are not in the material (TODO spec §8 Q2/Q9), hence the options.
 */
export function decodeWireTest(map, { wireMinA = 0.2, battMinV = 3.6 } = {}) {
  const amps = (v) => (v === undefined ? null : v / 100);
  const primaryA = amps(map.S), secondaryA = amps(map.C);
  const battV = map.B === undefined ? null : map.B / 100;
  return {
    primaryOk: primaryA !== null && primaryA >= wireMinA,
    secondaryOk: secondaryA !== null && secondaryA >= wireMinA,
    secondaryConfigured: secondaryA !== null,
    ledOk: map.L === undefined ? null : map.L > 0,
    battOk: battV === null ? null : battV >= battMinV,
    primaryA, secondaryA, battV, letters: map,
  };
}

export class TelemetryBuilder {
  /** @param {{altMethod?:'isa'|'hypso', sampleMs?:number, maxInterpAgeMs?:number, wireMinA?:number, battMinV?:number}} opts */
  constructor(opts = {}) {
    this.opts = { altMethod: 'isa', sampleMs: 1000, maxInterpAgeMs: 22000, ...opts };
    this.session = null;            // {groundAlt, groundPa}
    this.prevPa = null;             // {t, pa} last packet with pressure (MET interpolation)
    this.prevAlt = null;            // {t, pa, alt, te} last record with pressure altitude (hypsometric chain, rise fallback)
    this.lastRecord = null;
    this.refPos = null;             // last full lat/lon (for latm/latd partial positions)
    this.lastManualCutT = null;     // set by GroundLink.cutdown() → 'by' of the next cut-down report
  }
  startSession({ groundAlt, groundPa } = {}) {
    this.session = { groundAlt: num(groundAlt), groundPa: num(groundPa) };
    this.prevAlt = this.session.groundPa !== null && this.session.groundAlt !== null ? { t: null, pa: this.session.groundPa, alt: this.session.groundAlt, te: null } : null;
  }
  stopSession() { this.session = null; this.prevAlt = null; }
  set sampleMs(ms) { if (ms > 0) this.opts.sampleMs = ms; }

  // ---- records -------------------------------------------------------------------------------------
  /** DAT / MET message → records in chronological order (INF history first, the live sample last). */
  records(msg, t = msg.t ?? Date.now()) {
    if (msg.type !== 'DAT' && msg.type !== 'MET') return [];
    const p = msg.params;
    const out = [];
    const pa = num(p.pa);
    if (msg.type === 'MET') {
      let maxK = 0;
      for (let k = 1; k <= 9; k++) if (['spd', 'ang', 'te', 'hu'].some((x) => p[`${x}${k}`] !== undefined)) maxK = k;
      for (let k = maxK; k >= 1; k--) {
        const tk = t - k * this.opts.sampleMs;
        let paK = null;
        if (pa !== null && this.prevPa && t - this.prevPa.t <= this.opts.maxInterpAgeMs && t > this.prevPa.t) {
          const frac = Math.max(0, Math.min(1, (t - tk) / (t - this.prevPa.t)));
          paK = Math.round(pa + (this.prevPa.pa - pa) * frac);
        }
        out.push(this._record({ t: tk, src: 'INF', sondeId: p.id ?? null, seq: null, md: p.md ?? null, pa: paK, te: num(p[`te${k}`]), hu: num(p[`hu${k}`]), spd: num(p[`spd${k}`]), ang: num(p[`ang${k}`]), lat: null, lon: null, gpsAlt: null, rise: null, su: null, sats: null, params: p, raw: msg.raw, link: {} }));
      }
    }
    const pos = this._position(p);
    out.push(this._record({ t, src: msg.type, sondeId: p.id ?? null, seq: p.seq ?? null, md: p.md ?? null, pa, te: num(p.te), hu: num(p.hu), spd: num(p.spd), ang: num(p.ang), lat: pos.lat, lon: pos.lon, gpsAlt: num(p.alt), rise: num(p.rise), su: num(p.su), sats: num(p.sats), params: p, raw: msg.raw, link: { rssi: rssiFromParams(p), rs: num(p.rs), snr: num(p.snr), rec: num(p.rec) } }));
    if (pa !== null) this.prevPa = { t, pa };
    this.lastRecord = out[out.length - 1];
    return out;
  }
  _record(x) {
    const s = this.session;
    let alt = null, altAgl = null;
    if (s && x.pa !== null) alt = this._altitude(x);
    if (alt === null && x.gpsAlt !== null) alt = x.gpsAlt;
    if (alt !== null && s && s.groundAlt !== null) altAgl = +(alt - s.groundAlt).toFixed(1);
    let rise = x.rise;
    if (rise === null && alt !== null && this.prevAlt && this.prevAlt.t !== null && x.t > this.prevAlt.t) rise = +((alt - this.prevAlt.alt) / ((x.t - this.prevAlt.t) / 1000)).toFixed(2);
    if (alt !== null && x.pa !== null) this.prevAlt = { t: x.t, pa: x.pa, alt, te: x.te };
    const rec = {
      t: x.t, sondeId: x.sondeId, seq: x.seq, src: x.src, md: x.md, lat: x.lat, lon: x.lon, gpsAlt: x.gpsAlt, pa: x.pa,
      alt: alt === null ? null : +alt.toFixed(1), altAgl, te: x.te, hu: x.hu, td: x.te !== null && x.hu !== null ? dewPoint(x.te, x.hu) : null,
      spd: x.spd, ang: x.ang, rise, su: x.su, rssi: x.link.rssi ?? null, rs: x.link.rs ?? null, snr: x.link.snr ?? null, rec: x.link.rec ?? null,
      sats: x.sats, tei: num(x.params.tei), raw: x.raw, params: x.params,
      jam: num(x.params.jam), spoof: num(x.params.spoof),      // 3.11.8 GNSS integrity flags (0 none, 1 suspected, 2 detected) [C levels, I wording]
    };
    if (rec.td !== null) rec.td = +rec.td.toFixed(2);
    return rec;
  }
  /**
   * Pressure altitude AMSL. 'isa': ISA altitude shifted so groundPa ↦ groundAlt (QNH error removed).
   * 'hypso': hypsometric step from the previous level with the measured mean temperature
   * (Δz = R·T̄/g · ln(p₁/p₂)); falls back to 'isa' when no temperature is available.
   */
  _altitude(x) {
    const s = this.session;
    if (this.opts.altMethod === 'hypso' && this.prevAlt && x.te !== null && this.prevAlt.pa > 0 && x.pa > 0) {
      const tPrev = this.prevAlt.te ?? x.te;
      const tMean = (tPrev + x.te) / 2 + 273.15;
      return this.prevAlt.alt + (R_D * tMean / G0) * Math.log(this.prevAlt.pa / x.pa);
    }
    if (s.groundPa !== null && s.groundAlt !== null) return altFromPressure(x.pa, s.groundPa, s.groundAlt);
    return isaAltitude(x.pa);
  }
  /** Full lat/lon (0 = invalid) or, for older sondes, latm/lond + latd/lond relative to the last full fix (spec §5.10). */
  _position(p) {
    let lat = num(p.lat), lon = num(p.lon);
    if (lat !== null && lon !== null && !(lat === 0 && lon === 0)) { this.refPos = { lat, lon }; return { lat, lon }; }
    const ref = this.refPos;
    if (ref && p.latm !== undefined && p.lonm !== undefined) {         // minute part ·1e4 → degrees fraction = v/600000
      const f = (v, r) => Math.trunc(r) + Math.sign(r || 1) * v / 600000;
      return { lat: f(p.latm, ref.lat), lon: f(p.lonm, ref.lon) };
    }
    if (ref && p.latd !== undefined && p.lond !== undefined) {         // decimal part of the minutes (·1e4) – TODO spec §5.10 wording, verify
      const f = (v, r) => { const a = Math.abs(r), d = Math.trunc(a), m = Math.trunc((a - d) * 60); return Math.sign(r || 1) * (d + (m + v / 10000) / 60); };
      return { lat: f(p.latd, ref.lat), lon: f(p.lond, ref.lon) };
    }
    return { lat: null, lon: null };
  }

  // ---- packets / events -----------------------------------------------------------------------------
  /** PK (and DAT/MET) link quality → 'packet' event detail. */
  packet(msg, t = msg.t ?? Date.now()) {
    const p = msg.params;
    const rssi = rssiFromParams(p);
    if (rssi === null && p.rs === undefined) return null;
    return { rssi, rs: num(p.rs), snr: num(p.snr), rec: num(p.rec), t };
  }
  /**
   * 3.11.8 GNSS integrity (`jam`/`spoof` in DAT/MET): 'gnssIntegrity' event when a flag is raised
   * and when it clears again (feature flag gnssIntegrityEvents; the key semantics are [C], the
   * wording suspected/detected is [I] – spec §5.10).
   */
  integrityEvent(msg, t = msg.t ?? Date.now()) {
    if (this.opts.gnssIntegrityEvents === false) return null;
    const p = msg.params;
    if (p.jam === undefined && p.spoof === undefined) return null;
    const jam = num(p.jam) ?? 0, spoof = num(p.spoof) ?? 0;
    const prev = this._integrity || { jam: 0, spoof: 0 };
    if (jam === prev.jam && spoof === prev.spoof) return null;
    this._integrity = { jam, spoof };
    const level = (v) => (v >= 2 ? 'detected' : v >= 1 ? 'suspected' : 'none');
    return { type: 'gnssIntegrity', data: { id: msg.id, jam, spoof, jamming: level(jam), spoofing: level(spoof), t }, raw: msg.raw };
  }
  /** TXT / ANN / ANET / TIM → 'event' detail {type, data, raw} or null. */
  event(msg, t = msg.t ?? Date.now()) {
    const last = this.lastRecord;
    if (msg.type === 'TXT') {
      const d = parseTxtData(msg.data);
      if (!d) return { type: 'text', data: { id: msg.id, text: msg.data, params: msg.params }, raw: msg.raw };
      if (d.kind === 'C') {
        const manual = this.lastManualCutT !== null && t - this.lastManualCutT < 120000;
        return { type: 'cutdown', data: { id: msg.id, alt: last ? last.alt : null, altAgl: last ? last.altAgl : null, by: manual ? 'manual' : 'auto', letters: d.map, t }, raw: msg.raw };
      }
      if (d.kind === 'R') return { type: 'wireTest', data: { id: msg.id, ...decodeWireTest(d.map, this.opts), raw: msg.raw }, raw: msg.raw };
      if (d.kind === 'w') return { type: 'wireHeated', data: { id: msg.id, letters: d.map, t }, raw: msg.raw };
      return { type: 'text', data: { id: msg.id, kind: d.kind, letters: d.map, text: msg.data }, raw: msg.raw };
    }
    if (msg.type === 'ANN' || msg.type === 'ANET') return { type: 'announce', data: { id: msg.id, sid: msg.params.sid ?? null, params: msg.params, net: msg.type === 'ANET' }, raw: msg.raw };
    if (msg.type === 'TIM') return { type: 'timeout', data: { id: msg.id, params: msg.params }, raw: msg.raw };
    return null;
  }
}
