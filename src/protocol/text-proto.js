// Text ("bracket") command protocol of the RR4 (spec §1.3, §5.4, §5.8).
// Two queues: receiver commands (one in flight, 0.4 s response wait, retries) and per-sonde
// `<id>.exe=` commands (one per sonde, 8 s for the RES, ≥ 1 s spacing, part/TIM/Busy handling).
// Also parses every bracket *message* once and re-emits it as a 'message' event for the
// telemetry layer, so nobody parses lines twice.

import { parseBracketLine } from './lines.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TextProto extends EventTarget {
  /**
   * @param {import('./serial.js').SerialLink} serial
   * @param {{responseMs?:number, exeTimeoutMs?:number, exeSpacingMs?:number, exeAckMs?:number, now?:()=>number}} opts
   */
  constructor(serial, opts = {}) {
    super();
    this.serial = serial;
    this.opts = { responseMs: 400, exeTimeoutMs: 8000, exeSpacingMs: 1000, exeAckMs: 400, now: () => Date.now(), ...opts };
    this._q = []; this._inflight = null;         // receiver command queue
    this._sondes = new Map();                     // sondeId → {queue:[], cur:null, lastT:0}
    this._onLine = (e) => this._line(e.detail);
    serial.addEventListener('line', this._onLine);
  }
  dispose() { this.serial.removeEventListener('line', this._onLine); this._failAll(new Error('E_PORT_CLOSED')); }

  // ---- receiver commands ----------------------------------------------------------------------------
  /**
   * Send `text` and resolve with the response body (text inside the brackets). Error/Failed replies
   * are still "accepted" responses (spec §1.3) – callers decide. Rejects with E_TIMEOUT after retries.
   */
  command(text, { timeoutMs = this.opts.responseMs, retries = 0 } = {}) {
    text = String(text).replace(/[\r\n]+/g, ' ');    // one line = one command: no second command can ride along
    return new Promise((resolve, reject) => {
      this._q.push({ text, timeoutMs, retries, resolve, reject });
      this._pump();
    });
  }
  /** `key` → value string from `[key=value]`; null when the reply has another shape. */
  async query(key, o = {}) {
    const r = await this.command(key, o);
    const m = new RegExp(`^${key}\\s*=\\s*(.*)$`, 'i').exec(r);
    return m ? m[1].trim() : (/^(Error|Failed)/i.test(r) ? null : r.trim() || null);
  }
  /** Write-and-verify (spec §5.4): accept when the reply starts with `key=` and parses to the value. */
  async setting(key, value, o = {}) {
    const r = await this.command(`${key}=${value}`, { retries: 2, ...o });
    const m = new RegExp(`^${key}\\s*=\\s*(.*)$`, 'i').exec(r);
    if (!m) throw new Error(`E_SET_FAILED: ${key} → ${r || '(empty)'}`);
    const got = m[1].trim();
    if (String(got) !== String(value) && Number(got) !== Number(value)) throw new Error(`E_SET_MISMATCH: ${key}=${got} (wanted ${value})`);
    return got;
  }
  async _pump() {
    if (this._inflight || !this._q.length) return;
    const item = this._q.shift();
    this._inflight = item;
    try { await this.serial.writeText(item.text); }
    catch (e) { this._inflight = null; item.reject(e); this._pump(); return; }
    item.timer = setTimeout(() => this._timeout(item), item.timeoutMs);
  }
  _timeout(item) {
    if (this._inflight !== item) return;
    this._inflight = null;
    if (item.retries > 0) { item.retries--; this._q.unshift(item); }
    else item.reject(new Error(`E_TIMEOUT: no reply to '${item.text}'`));
    this._pump();
  }
  _response(body) {
    const item = this._inflight;
    if (!item) return;                                  // unsolicited response → ignore (spec §1.2)
    clearTimeout(item.timer); this._inflight = null;
    item.resolve(body);
    this._pump();
  }

  // ---- sonde commands (spec §5.8) ------------------------------------------------------------------
  /**
   * `<sondeId>.exe=<cmd>` → resolves with the RES text (parts joined). `oneway` sends `.cmd=` and
   * resolves after the RR4 accepted the line. Rejects: E_TIMEOUT_RADIO (TIM / no RES), E_BUSY,
   * E_SONDE_ERROR (RES starts with Error), E_RR4 (receiver refused the line).
   */
  exe(sondeId, cmd, { timeoutMs = this.opts.exeTimeoutMs, oneway = false } = {}) {
    const id = sondeId === '!' ? '!' : Number(sondeId);
    if (id !== '!' && !Number.isInteger(id)) return Promise.reject(new Error('E_NO_SONDE'));
    const s = this._sonde(id);
    return new Promise((resolve, reject) => { s.queue.push({ cmd, timeoutMs, oneway, resolve, reject, parts: [] }); this._pumpSonde(id); });
  }
  _sonde(id) { if (!this._sondes.has(id)) this._sondes.set(id, { queue: [], cur: null, lastT: -1e12 }); return this._sondes.get(id); }
  async _pumpSonde(id) {
    const s = this._sonde(id);
    if (s.cur || !s.queue.length) return;
    const item = s.queue.shift();
    s.cur = item;
    const wait = s.lastT + this.opts.exeSpacingMs - this.opts.now();
    if (wait > 0) await sleep(wait);
    if (s.cur !== item) return;
    s.lastT = this.opts.now();
    const line = `${id}.${item.oneway ? 'cmd' : 'exe'}=${item.cmd}`;
    try {
      const ack = await this.command(line, { timeoutMs: this.opts.exeAckMs, retries: 1 });
      if (/^(Error|Failed)/i.test(ack)) throw new Error(`E_RR4: ${ack}`);
      this.dispatchEvent(new CustomEvent('exe', { detail: { id, cmd: item.cmd, ack } }));
    } catch (e) { this._finishSonde(id, item, e); return; }
    if (item.oneway) { this._finishSonde(id, item, null, ''); return; }
    item.timer = setTimeout(() => this._finishSonde(id, item, new Error(`E_TIMEOUT_RADIO: no RES to '${item.cmd}' within ${item.timeoutMs} ms`)), item.timeoutMs);
  }
  _finishSonde(id, item, err, text) {
    const s = this._sonde(id);
    if (s.cur !== item) return;
    clearTimeout(item.timer); s.cur = null; s.lastT = this.opts.now();
    if (err) item.reject(err); else item.resolve(text);
    this._pumpSonde(id);
  }
  /** RES/TIM routing: by `id=` when present, else to the oldest pending sonde command. */
  _sondeMessage(msg) {
    let id = msg.id;
    let s = id !== null && this._sondes.has(id) ? this._sondes.get(id) : null;
    if (!s || !s.cur) {
      let best = null;
      for (const [k, v] of this._sondes) if (v.cur && (!best || v.lastT < best.v.lastT)) best = { k, v };
      if (!best) return; id = best.k; s = best.v;
    }
    const item = s.cur;
    if (msg.type === 'TIM') { this._finishSonde(id, item, new Error(`E_TIMEOUT_RADIO: TIM for '${item.cmd}'`)); return; }
    item.parts.push(msg.data);
    if (msg.params.part !== undefined && msg.params.part !== null && msg.params.part !== '') return;   // more parts follow
    const text = item.parts.join('');
    if (/^busy/i.test(text)) this._finishSonde(id, item, new Error(`E_BUSY: ${text}`));
    else if (/^error/i.test(text)) this._finishSonde(id, item, new Error(`E_SONDE_ERROR: ${text}`));
    else this._finishSonde(id, item, null, text);
  }
  _failAll(err) {
    if (this._inflight) { clearTimeout(this._inflight.timer); this._inflight.reject(err); this._inflight = null; }
    for (const it of this._q.splice(0)) it.reject(err);
    for (const [id, s] of this._sondes) { if (s.cur) this._finishSonde(id, s.cur, err); for (const it of s.queue.splice(0)) it.reject(err); }
  }

  // ---- line dispatch --------------------------------------------------------------------------------
  _line(d) {
    if (d.dir !== 'rx') return;
    if (d.kind === 'response') { this._response(d.bracket.slice(1, -1)); return; }
    if (d.kind !== 'message') return;
    const msg = parseBracketLine(d.bracket);
    if (!msg) return;
    msg.t = d.t;
    if (msg.type === 'RES' || msg.type === 'TIM') this._sondeMessage(msg);
    this.dispatchEvent(new CustomEvent('message', { detail: msg }));
  }
}
