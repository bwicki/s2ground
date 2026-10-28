// MockWsRr4: a tiny RFC 6455 WebSocket server (node 'http' + 'crypto', no dependencies) that fronts
// the scripted MockSerial RR4/S2 – the WiFi counterpart of mock-serial.js (spec §1.8).
// Binary frames carry TO + SSP message bytes; text frames (optional, `textChannel`) carry the
// bracket/text lines so both hypotheses of open question 20 can be exercised.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { MockSerial } from './mock-serial.js';
import { hexToBytes, bytesToHex } from '../../src/protocol/ssp-bin.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, Buffer.from(payload)]);
}

export class MockWsRr4 extends MockSerial {
  /** @param {{textChannel?:boolean, path?:string} & ConstructorParameters<typeof MockSerial>[0]} o */
  constructor(o = {}) {
    super(o);
    this.o.textChannel = o.textChannel !== undefined ? o.textChannel : false;
    this.o.path = o.path || '/ws';
    this.socket = null; this.connections = 0; this.textFramesRx = []; this.binaryFramesRx = 0;
    this.server = createServer((req, res) => { res.writeHead(404); res.end(); });
    this.server.on('upgrade', (req, socket) => this._upgrade(req, socket));
  }
  /** Start listening; resolves with {host, port, path}. */
  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve({ host: '127.0.0.1', port: this.port, path: this.o.path }); }));
  }
  async stop() { if (this.socket) { try { this.socket.destroy(); } catch { /* ignore */ } this.socket = null; } await new Promise((r) => this.server.close(() => r())); }
  /** Drop the client (simulates WiFi loss). */
  dropClient() { if (this.socket) { this.socket.write(frame(0x8, Buffer.from([0x03, 0xe8]))); this.socket.end(); this.socket = null; this.opened = false; } }

  _upgrade(req, socket) {
    if (req.url !== this.o.path) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    this.socket = socket; this.connections++; this.opened = true;
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => { buf = Buffer.concat([buf, d]); buf = this._parse(buf, socket); });
    socket.on('close', () => { if (this.socket === socket) { this.socket = null; this.opened = false; } });
    socket.on('error', () => {});
  }
  _parse(buf, socket) {
    for (;;) {
      if (buf.length < 2) return buf;
      const fin = !!(buf[0] & 0x80), opcode = buf[0] & 0x0f, masked = !!(buf[1] & 0x80);
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return buf; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return buf; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return buf;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + maskLen + len);
      if (!fin) continue;                                         // fragmentation not needed for the tests
      if (opcode === 0x8) { socket.write(frame(0x8, payload.subarray(0, 2))); socket.end(); continue; }
      if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue; }
      if (opcode === 0x2) { this.binaryFramesRx++; setTimeout(() => this._ssp(bytesToHex(payload)), this.o.delayMs); continue; }
      if (opcode === 0x1) {
        const text = payload.toString('latin1');
        this.textFramesRx.push(text);
        if (this.o.textChannel) for (const line of text.split(/[\r\n]+/)) if (line.trim()) setTimeout(() => this._text(line.trim()), this.o.delayMs);
      }
    }
  }
  /** Device → client: SSP hex lines become binary frames (TO + message), everything else a text frame (only with textChannel). */
  push(line) {
    if (!this.socket) return;
    if (line.startsWith('0x')) { this.socket.write(frame(0x2, hexToBytes(line))); return; }
    if (this.o.textChannel) this.socket.write(frame(0x1, Buffer.from(`${line}\r\n`, 'latin1')));
  }
  pushRaw() { /* not meaningful over WebSocket */ }
  async close() { this.dropClient(); }
}
