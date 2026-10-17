// Web Serial port wrapper (spec §1.1): opens 38400 8N1 (57600 for the SA1 cable), reads lines,
// writes text commands ("…\r\n", ≥ 0.2 s apart) and SSP hex frames ("\n0x…\n"), keeps a ring
// buffer of the last 2000 lines with direction + timestamp and emits 'line' events.
// Anything that behaves like a Web Serial port (open/close/readable/writable/getInfo) can be
// injected, which is how the node tests drive the whole stack with a scripted MockSerial.

import { classifyLine } from './lines.js';

const LATIN1 = typeof TextDecoder !== 'undefined' ? new TextDecoder('latin1') : null;

export class SerialLink extends EventTarget {
  static isSupported() { return typeof navigator !== 'undefined' && !!navigator.serial; }

  /**
   * Previously granted port (navigator.serial.getPorts()); optional USB id filter {usbVendorId, usbProductId}.
   * Returns null when nothing matches – the caller then calls requestPort() (needs a user gesture).
   */
  static async rememberedPort(filter = null) {
    if (!SerialLink.isSupported()) return null;
    const ports = await navigator.serial.getPorts();
    if (!ports.length) return null;
    if (filter && filter.usbVendorId) {
      const hit = ports.find((p) => { const i = p.getInfo ? p.getInfo() : {}; return i.usbVendorId === filter.usbVendorId && (!filter.usbProductId || i.usbProductId === filter.usbProductId); });
      if (hit) return hit;
    }
    return ports.length === 1 ? ports[0] : null;
  }

  /** @param {{textSpacingMs?:number, ringSize?:number, joinOpenBracket?:boolean, now?:()=>number}} opts */
  constructor(opts = {}) {
    super();
    this.opts = { textSpacingMs: 200, ringSize: 2000, joinOpenBracket: true, now: () => Date.now(), ...opts };
    this.port = null; this.reader = null; this.writer = null;
    this.lines = [];                   // ring buffer [{dir, text, t}]
    this.rxLines = 0; this.txLines = 0;
    this._buf = ''; this._held = null; // partial line / open-bracket continuation (about reply with '\n', spec §1.3)
    this._lastTextT = 0; this._writeChain = Promise.resolve();
    this._open = false; this._closing = false;
  }

  get isOpen() { return this._open; }
  /** USB ids of the chosen port (admin page shows them; also used to re-find the port later). */
  get info() { const i = this.port && this.port.getInfo ? this.port.getInfo() : {}; return { usbVendorId: i.usbVendorId ?? null, usbProductId: i.usbProductId ?? null }; }

  /** @param {{port?:object, baudRate?:number, filters?:object[]}} o – without `port`: remembered port, else requestPort(). */
  async open({ port = null, baudRate = 38400, filters = null } = {}) {
    if (this._open) throw new Error('E_PORT_OPEN');
    if (!port) {
      if (!SerialLink.isSupported()) throw new Error('E_NO_WEBSERIAL');
      port = await navigator.serial.requestPort(filters ? { filters } : {});
    }
    this.port = port;
    // 8N1, no flow control = the library defaults the original software relies on (spec §1.1)
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 4096 });
    this._open = true; this._closing = false; this._buf = ''; this._held = null;
    this.writer = port.writable.getWriter();
    this._readLoop();
    return this.info;
  }

  async close() {
    if (!this._open) return;
    this._closing = true; this._open = false;
    try { if (this.reader) await this.reader.cancel(); } catch { /* reader already gone */ }
    try { if (this.writer) { this.writer.releaseLock(); } } catch { /* ignore */ }
    this.writer = null;
    await this._readerDone;
    try { await this.port.close(); } catch { /* port already closed */ }
    this.dispatchEvent(new CustomEvent('close', { detail: { reason: 'closed' } }));
  }

  // ---- writing -------------------------------------------------------------------------------------
  /** Text command: "<text>\r\n", non-ASCII dropped, ≥ textSpacingMs after the previous text command. */
  writeText(text) {
    return this._enqueueWrite(async () => {
      const wait = this._lastTextT + this.opts.textSpacingMs - this.opts.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      await this._raw(`${String(text).replace(/[^\x00-\x7f]/g, '')}\r\n`);
      this._lastTextT = this.opts.now();
      this._log('tx', String(text));
    });
  }
  /** SSP frame: "\n0x…\n" (the leading newline terminates any half-typed text, spec §1.1). */
  writeSsp(hex) {
    return this._enqueueWrite(async () => { await this._raw(`\n${hex}\n`); this._log('tx', hex); });
  }
  _enqueueWrite(fn) {
    const p = this._writeChain.then(fn);
    this._writeChain = p.catch(() => {});
    return p;
  }
  async _raw(str) {
    if (!this._open || !this.writer) throw new Error('E_PORT_CLOSED');
    const bytes = Uint8Array.from(str, (c) => c.charCodeAt(0) & 0xff);
    await this.writer.write(bytes);
  }

  // ---- reading -------------------------------------------------------------------------------------
  _readLoop() {
    this._readerDone = (async () => {
      let reason = 'eof', eof = false;
      try {
        while (this._open && this.port.readable && !eof) {
          this.reader = this.port.readable.getReader();
          try {
            for (;;) {
              const { value, done } = await this.reader.read();
              if (done) { eof = true; break; }           // stream ended (device gone or cancel())
              if (value) this._feed(value);
            }
          } catch (e) {
            // a fatal read error (device unplugged) ends the loop; non-fatal ones re-acquire the reader
            if (!this._open) break;
            reason = `lost: ${e && e.message}`;
            this.dispatchEvent(new CustomEvent('error', { detail: e }));
            if (!(e && (e.name === 'BufferOverrunError' || e.name === 'FramingError' || e.name === 'ParityError' || e.name === 'BreakError'))) break;
          } finally {
            try { this.reader.releaseLock(); } catch { /* ignore */ }
          }
        }
      } finally {
        this.reader = null;
        if (this._open) { this._open = false; this.dispatchEvent(new CustomEvent('close', { detail: { reason } })); }
      }
    })();
  }
  /** Decode latin-1, split on \r\n / \n / \r without producing empty lines in between (spec §1.1). */
  _feed(bytes) {
    this._buf += LATIN1 ? LATIN1.decode(bytes, { stream: true }) : String.fromCharCode(...bytes);
    if (this._buf.length > 65536) this._buf = this._buf.slice(-4096);   // no newline for 64 KB = garbage, not a line: bound the buffer
    let i;
    while ((i = this._buf.search(/[\r\n]/)) >= 0) {
      const line = this._buf.slice(0, i);
      this._buf = this._buf.slice(i + 1);
      if (line.trim() === '' && this._held === null) continue;       // the second half of \r\n or \n\r
      this._emitLine(line);
    }
  }
  _emitLine(line) {
    // The `about` reply can contain '\n' inside its quotes (spec §1.3/5.1): keep an unterminated
    // "[…" line and join it with what follows, bounded so junk cannot swallow real traffic.
    let joined = false;
    if (this._held !== null) { line = `${this._held} ${line}`; this._held = null; joined = true; }
    const t = line.replace(/^[\s>\0]+/, '');
    if (!joined && this.opts.joinOpenBracket && t.startsWith('[') && !t.includes(']') && t.length < 400) { this._held = line; return; }
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
