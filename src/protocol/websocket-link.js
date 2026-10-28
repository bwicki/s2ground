// WebSocket transport for the SSP link (spec §1.8, 3.11.8): the RR4's WiFi. A port-like object
// with the same surface SerialLink offers to TextProto / SspSession (open/close, writeText,
// writeSsp, 'line' events with kind/hex/bracket, ring buffer, rx/tx counters), so the rest of the
// protocol layer does not know which transport it runs on.
//
// Framing [C, from the Sparvio library class]: one *binary* WebSocket frame = TO byte + SSP message
// (type byte + body) – the bytes of the serial hex line without "0x"/hex and without the newline.
// Text frames: the original client drops them; we treat a received text frame as serial lines
// (bracket messages / responses) in case the RR4 does offer its text channel over WiFi [U, open
// question 20], and `writeText` sends the command as a text frame. Whether anybody answers is
// reported by `textFramesSeen` so the facade can mark the text channel unavailable.
//
// What is NOT known [U]: the RR4's port/path and its AP address (open question 19). Both are
// parameters of open().

import { classifyLine } from './lines.js';
import { hexToBytes, bytesToHex } from './ssp-bin.js';


/** Build `ws://host[:port]/path` from parts; `url` wins when given. */
export function wsUrl({ url = null, host = null, port = null, path = '/', secure = false } = {}) {
  if (url) return String(url);
  if (!host) throw new Error('E_WS_URL: host required');
  const h = /:/.test(host) && !host.startsWith('[') ? `[${host}]` : host;   // bare IPv6
  const p = port ? `:${port}` : '';
  const pa = path ? (path.startsWith('/') ? path : `/${path}`) : '/';
  return `${secure ? 'wss' : 'ws'}://${h}${p}${pa}`;
}

export class WebSocketLink extends EventTarget {
  static isSupported() { return typeof WebSocket !== 'undefined'; }

  /** @param {{openTimeoutMs?:number, textSpacingMs?:number, ringSize?:number, probeMs?:number, WebSocket?:Function, now?:()=>number}} opts */
  constructor(opts = {}) {
    super();
    this.opts = { openTimeoutMs: 3000, textSpacingMs: 200, ringSize: 2000, probeMs: 2000, WebSocket: typeof WebSocket !== 'undefined' ? WebSocket : null, now: () => Date.now(), ...opts };
    this.probeMs = this.opts.probeMs;         // read by SspSession: the WS client probes every 2 s (spec §1.8)
    this.ws = null; this.url = null;
    this.lines = []; this.rxLines = 0; this.txLines = 0;
    this.textFramesSeen = 0; this.binaryFramesSeen = 0;
    this._buf = ''; this._lastTextT = 0; this._writeChain = Promise.resolve();
    this._open = false; this._closing = false;
  }

  get isOpen() { return this._open; }
  /** Analogue of SerialLink.info: no USB ids, the URL instead. */
  get info() { return { usbVendorId: null, usbProductId: null, url: this.url, transport: 'wifi' }; }

  /** @param {{url?:string, host?:string, port?:number, path?:string, secure?:boolean}} o */
  async open(o = {}) {
    if (this._open) throw new Error('E_PORT_OPEN');
    const Ctor = this.opts.WebSocket;
    if (!Ctor) throw new Error('E_NO_WEBSOCKET');
    this.url = wsUrl(o);
    const ws = new Ctor(this.url);
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      const tm = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error(`E_WS_TIMEOUT: no connection to ${this.url} within ${this.opts.openTimeoutMs} ms`)); }, this.opts.openTimeoutMs);
      ws.addEventListener('open', () => { clearTimeout(tm); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(tm); reject(new Error(`E_WS_CONNECT: ${this.url}`)); }, { once: true });
      ws.addEventListener('close', () => { clearTimeout(tm); reject(new Error(`E_WS_CONNECT: ${this.url} closed`)); }, { once: true });
    });
    this.ws = ws; this._open = true; this._closing = false; this._buf = '';
    ws.addEventListener('message', (e) => this._message(e.data));
    ws.addEventListener('close', (e) => this._closed(this._closing ? 'closed' : `lost: code ${e.code}`));
    ws.addEventListener('error', (e) => this.dispatchEvent(new CustomEvent('error', { detail: e })));
    return this.info;
  }

  async close() {
    if (!this._open) return;
    this._closing = true;
    try { this.ws.close(); } catch { /* ignore */ }
    // some clients do not emit 'close' synchronously; settle our state either way
    this._closed('closed');
  }
  _closed(reason) {
    if (!this._open) return;
    this._open = false; this.ws = null;
    this.dispatchEvent(new CustomEvent('close', { detail: { reason } }));
  }

  // ---- writing -------------------------------------------------------------------------------------
  /** SSP frame "0x…" → binary WebSocket frame (TO + message bytes). */
  writeSsp(hex) {
    return this._enqueue(async () => { this._need(); this.ws.send(hexToBytes(hex)); this._log('tx', hex); });
  }
  /** Text command as a text frame (one command per frame, no line terminator needed) – answered only if the RR4 has a text channel over WiFi [U]. */
  writeText(text) {
    return this._enqueue(async () => {
      const wait = this._lastTextT + this.opts.textSpacingMs - this.opts.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this._need();
      const t = String(text).replace(/[^\x00-\x7f]/g, '');
      this.ws.send(`${t}\r\n`);
      this._lastTextT = this.opts.now();
      this._log('tx', t);
    });
  }
  _enqueue(fn) { const p = this._writeChain.then(fn); this._writeChain = p.catch(() => {}); return p; }
  _need() { if (!this._open || !this.ws) throw new Error('E_PORT_CLOSED'); }

  // ---- reading -------------------------------------------------------------------------------------
  _message(data) {
    if (typeof data === 'string') { this.textFramesSeen++; this._feedText(data); return; }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : (data && data.buffer ? new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength) : null);
    if (!bytes) return;
    this.binaryFramesSeen++;
    if (bytes.length < 2) return;                         // needs at least TO + MSGTYPE
    const hex = bytesToHex(bytes);
    this._log('rx', hex);
    this.dispatchEvent(new CustomEvent('line', { detail: { dir: 'rx', text: hex, t: this.opts.now(), kind: 'ssp', hex } }));
  }
  /** Text frames may carry one or several lines; split exactly like the serial reader. */
  _feedText(str) {
    this._buf += str;
    let i;
    while ((i = this._buf.search(/[\r\n]/)) >= 0) {
      const line = this._buf.slice(0, i); this._buf = this._buf.slice(i + 1);
      if (line.trim() !== '') this._emitLine(line);
    }
    if (this._buf.length && !/[\r\n]/.test(this._buf) && this._buf.trim().endsWith(']')) { this._emitLine(this._buf); this._buf = ''; }   // frame = whole line without terminator
  }
  _emitLine(line) {
    this._log('rx', line);
    const c = classifyLine(line);
    this.dispatchEvent(new CustomEvent('line', { detail: { dir: 'rx', text: line, t: this.opts.now(), kind: c.kind, hex: c.hex, bracket: c.bracket } }));
  }
  _log(dir, text) {
    if (dir === 'rx') this.rxLines++; else this.txLines++;
    const entry = { dir, text, t: this.opts.now() };
    this.lines.push(entry);
    if (this.lines.length > this.opts.ringSize) this.lines.splice(0, this.lines.length - this.opts.ringSize);
    if (dir === 'tx') this.dispatchEvent(new CustomEvent('line', { detail: { ...entry, kind: 'tx' } }));
  }
}
