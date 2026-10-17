// MockSerial: a Web-Serial-like port backed by a scripted RR4 (+ S2) so GroundLink can be tested
// end-to-end in node. It answers text commands (spec §5.1/§5.4/§5.8), joins us to an SSP network
// (§5.2/§5.3), reports `components`/`net`/S2 status and lets a test inject raw lines.

import { decodeFrame, encodeFrame, Typed, plain, REF } from '../../web/src/protocol/ssp-bin.js';

const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
export const NET = { freq: 433900000, loraSpreadingFactor: 9, loraBandwidth: 0, loraCodingRate: 1, radioTimeslots: 6, radioSlotMs: 500, radioMaxData: 60, samplingInterval: 1000, radioGroundSlotMs: 500 };

export class MockSerial {
  /** @param {{withS2?:boolean, ssp?:boolean, pcId?:number, s2Oid?:number, withRev?:boolean, mapStyle?:'namemap'|'map', sondeId?:number}} o */
  constructor(o = {}) {
    this.o = { withS2: true, ssp: true, pcId: 3, s2Oid: 2, withRev: true, mapStyle: 'namemap', sondeId: 12345, delayMs: 2, ...o };
    this.opened = false; this.rxText = []; this.rxFrames = []; this.net = { ...NET }; this.s2 = { md: 1, bat: 4.05, pr: 96240, mac: this.o.sondeId, condition: 0, txCriterion: 3, power: 13, powerBefore: 0, gnssEnabled: true, net: null, relAlt: null };
    this.cutalt = 65535; this.exeLog = []; this.sets = []; this.calls = [];
    this.inbuf = '';
    this.readable = new ReadableStream({ start: (c) => { this._ctrl = c; } });
    this.writable = new WritableStream({ write: (chunk) => this._write(chunk) });
  }
  getInfo() { return { usbVendorId: 0x0403, usbProductId: 0x6015 }; }
  async open() { this.opened = true; }
  async close() { this.opened = false; try { this._ctrl.close(); } catch { /* already closed */ } }
  /** Inject a received line (device → PC). */
  push(line) { if (this.opened) this._ctrl.enqueue(enc(`${line}\r\n`)); }
  pushRaw(bytes) { if (this.opened) this._ctrl.enqueue(bytes instanceof Uint8Array ? bytes : enc(bytes)); }
  _write(chunk) {
    this.inbuf += String.fromCharCode(...chunk);
    let i;
    while ((i = this.inbuf.search(/[\r\n]/)) >= 0) {
      const line = this.inbuf.slice(0, i).trim(); this.inbuf = this.inbuf.slice(i + 1);
      if (!line) continue;
      setTimeout(() => (line.startsWith('0x') ? this._ssp(line) : this._text(line)), this.o.delayMs);
    }
  }

  // ---- text protocol ------------------------------------------------------------------------------
  _text(line) {
    this.rxText.push(line);
    const reply = (s) => this.push(`[${s}]`);
    let m;
    if (line === 'echo=0') return reply('echo=0');
    if (line === 'mac') return reply('MAC=1F3A');
    if (line === 'about') return this.push('[about="Sparv RR4 hw=4, fw=1.4.2, prot=6"]');
    if (line === 'frequency') return reply(`frequency=${this.net.freq}`);
    if (line === 'ts') return reply(`ts=${this.net.radioTimeslots}`);
    if (line === 'sample_ms') return reply(`sample_ms=${this.net.samplingInterval}`);
    if (line === 'sonde_slot_length') return reply(`sonde_slot_length=${this.net.radioSlotMs}`);
    if (line === 'max_data') return reply(`max_data=${this.net.radioMaxData}`);
    if (line === 'temp') return reply('temp=21.5, pr=96250');
    if (line === 'bat') return reply('bat=4.02');
    if (line === 'annNet') return reply('annNet');
    if ((m = /^frequency=(\d+)$/.exec(line))) { this.net.freq = Number(m[1]); this._reportNet(); return reply(line); }
    if ((m = /^ts=(\d+)$/.exec(line))) { this.net.radioTimeslots = Number(m[1]); this._reportNet(); return reply(line); }
    if ((m = /^sample_ms=(\d+)$/.exec(line))) { this.net.samplingInterval = Number(m[1]); this._reportNet(); return reply(line); }
    if ((m = /^(\d+|!)\.(exe|cmd)=(.*)$/.exec(line))) return this._exe(m[1], m[2], m[3], reply, line);
    return reply(`Error: unknown command ${line}`);
  }
  _exe(id, kind, cmd, reply, line) {
    this.exeLog.push(cmd);
    reply(line);                                        // the RR4 acknowledges the line (spec §1.6)
    if (Number(id) !== this.o.sondeId && id !== '!') { setTimeout(() => this.push('[#TIM:]'), 30); return; }
    const res = (text, extra = '') => setTimeout(() => this.push(`[#RES:q=64${extra}:${text}]`), 40);
    let m;
    if (cmd === 'wires') { if (kind === 'exe') res('OK'); setTimeout(() => this.push(`[#TXT:id=${id}:R(S57B411C0L1)]`), 60); return; }
    if ((m = /^relAP=(\d+):(\d+)$/.exec(cmd))) { this.cutalt = Number(m[2]); this.relHalfPa = Number(m[1]); res('OK'); return; }
    if ((m = /^params=(.*)$/.exec(cmd))) {
      res('OK');
      const ids = m[1].split(',');
      const parts = [`id=${id}`, 'seq=7', 'md=1'];
      if (ids.includes('06')) parts.push('role=1'); if (ids.includes('13')) parts.push('fwver=312'); if (ids.includes('15')) parts.push(`cutalt=${this.cutalt}`); if (ids.includes('17')) parts.push('supmul=1');
      setTimeout(() => this.push(`[#DAT:${parts.join(',')}]`), 80);
      return;
    }
    if (cmd === 'relBal' || /^relBal=/.test(cmd)) { this.push('[#RES:q=70,part=1:Burn]'); res('ing'); setTimeout(() => this.push(`[#TXT:id=${id}:C(A1234T56)]`), 120); return; }
    if (cmd === 'relGnd') { res('OK relGnd'); return; }
    if (/^beep=/.test(cmd)) { res('OK'); return; }
    if ((m = /^mode=(\d)$/.exec(cmd))) { this.s2.md = Number(m[1]); res(`mode=${m[1]}`); return; }
    if (cmd === 'busy') { res('Busy'); return; }
    if (cmd === 'fail') { res('Error: nope'); return; }
    if (cmd === 'silent') return;                       // never answers → E_TIMEOUT_RADIO
    res(`OK ${cmd}`);
  }

  // ---- SSP ------------------------------------------------------------------------------------------
  _send(msg) { this.push(encodeFrame(msg)); }
  _nameMap(pairs) { return this.o.mapStyle === 'map' ? new Typed(22, new Map(pairs)) : new Typed(REF.NAMEMAP, new Map(pairs)); }
  _report(oid, pairs) { this._send({ to: this.o.pcId, name: 'rep', body: { map: new Map([[oid, this._nameMap(pairs)]]) } }); }
  _reportNet() { if (this.joined) this._report(1, [[1201, new Typed(REF.NET_V6, this.net)]]); }
  components() { return this.o.withS2 && this.s2Present !== false ? [1, this.o.s2Oid] : [1]; }
  _ssp(line) {
    if (!this.o.ssp || this.muted) return;              // muted = the RR4 stopped talking SSP (keep-alive test)
    let f; try { f = decodeFrame(line); } catch (e) { this.badFrames = (this.badFrames || 0) + 1; return; }
    this.rxFrames.push(f);
    const b = f.body, me = this.o.pcId;
    if (f.name === 'cinfo') {
      if (this.o.withRev) this._send({ to: 0xff, name: 'newidWithRev', body: { tk: 1, id: me, prio: 50, revision: 7, name: '' } });
      else this._send({ to: 0xff, name: 'newid', body: { tk: 1, id: me, prio: 50, name: '' } });
      this.joined = true; return;
    }
    if (f.name === 'newidAck') { this.acked = b.revision; return; }
    const reply = (val) => this._send({ to: me, name: 'reply', body: { from: f.to, tk: b.tk, b: val } });
    const nack = (code) => this._send({ to: me, name: 'nack', body: { from: f.to, tk: b.tk, code } });
    if (f.name === 'sub') {
      const syms = plain(b.sym);
      if (f.to === 1 && syms.includes(13)) this._report(1, [[13, this.components().map((x) => x)]]);
      if (f.to === 1 && syms.includes(1201)) this._report(1, [[774, 5], [599, true], [1201, new Typed(REF.NET_V6, this.net)], [1235, new Typed(REF.ENCKEY, { payload: new Uint8Array(0), unixEpochStamp: 0 })]]);
      if (f.to === this.o.s2Oid) this._report(this.o.s2Oid, this._s2Pairs());
      return;
    }
    if (f.name === 'uget') {
      const syms = plain(b.var);
      const val = (s) => {
        if (s === 5) return f.to === 1 ? 'RR4' : f.to === this.o.s2Oid ? 'S2_H3-R-B20' : 'other';
        const p = new Map(this._s2Pairs()); if (p.has(s)) return p.get(s);
        return null;
      };
      if (f.to !== 1 && f.to !== this.o.s2Oid) return;             // unknown object never answers
      reply(syms.map(val)); return;
    }
    if (f.name === 'getVarType') {
      const syms = plain(b.sym);
      const schemaOf = (s) => ({ 1201: REF.NET_V6, 774: 2, 599: 1, 1235: REF.ENCKEY, 1100: 2, 1200: 6, 314: 7, 890: 6, 336: 6, 1226: 2, 1203: 4, 1239: 4, 587: 1 })[s] ?? 21;
      reply(new Typed(REF.SCHEMALIST, syms.map((s) => [schemaOf(s), s === 1226 || s === 1203 || s === 1201 ? 1 : 0]))); return;
    }
    if (f.name === 'set') {
      const map = plain(b.map);
      this.sets.push({ to: f.to, map });
      if (map.has(1201)) { const v = map.get(1201); if (f.to === 1) { this.net = { ...v }; reply(null); this._reportNet(); } else { this.s2.net = { ...v }; reply(null); } return; }
      if (map.has(1105)) { if (this.o.s2RelAlt) { this.s2.relAlt = map.get(1105); reply(null); } else nack(5); return; }
      nack(5); return;
    }
    if (f.name === 'call') {
      const arg = plain(b.arg);
      this.calls.push({ to: f.to, sym: b.sym, arg });
      if (b.sym === 24) { reply(me); return; }
      if (b.sym === 598) { this.aidCalls = (this.aidCalls || 0) + 1; reply(this.aidCalls <= 2 ? this._ubx(this.aidCalls) : new Uint8Array(0)); return; }
      if (b.sym === 594) { if (!(arg instanceof Uint8Array) || arg.length > 50 || (this.aidChunks === undefined && arg[0] !== 0xff)) { nack(6); return; } this.aidChunks = (this.aidChunks || 0) + 1; reply(null); return; }
      nack(14); return;
    }
  }
  _s2Pairs() {
    const s = this.s2;
    return [[587, s.gnssEnabled], [1100, new Typed(2, s.md)], [1200, new Typed(6, s.mac)], [314, s.bat], [336, new Typed(6, s.condition)], [890, new Typed(6, s.pr)], [1226, new Typed(2, s.txCriterion)], [1203, new Typed(4, s.power)], [1239, new Typed(4, s.powerBefore)]];
  }
  /** A fake UBX-MGA frame (payload n·30 bytes) so the upload has to chunk it. */
  _ubx(n) { const len = 30 * n; const f = new Uint8Array(8 + len); f[0] = 0xb5; f[1] = 0x62; f[2] = 0x13; f[3] = 0x00; f[4] = len & 0xff; f[5] = len >> 8; for (let i = 0; i < len; i++) f[6 + i] = i; return f; }
  /** Simulated S2 radio telemetry line. */
  dat(extra = {}) {
    const p = { id: this.o.sondeId, seq: 10, md: 1, lat: 47.4433, lon: 8.5617, alt: 440.2, pa: 96240, te: 12.30, hu: 71.0, spd: 1.2, ang: 230.0, rise: 0.0, su: 4.05, rs: -70, snr: 9, sats: 9, rec: 0, ...extra };
    this.push(`[#DAT:${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(',')}]`);
  }
}
