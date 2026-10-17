// node --test: SerialLink line reader/writer (spec §1.1/§1.2/§1.3): terminators, '>' and NUL
// stripping, latin-1, the two-line `about` reply, text spacing and the SSP line framing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SerialLink } from '../../src/protocol/serial.js';

function fakePort() {
  const written = [];
  let ctrl;
  return {
    written,
    push: (bytes) => ctrl.enqueue(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes, (c) => c.charCodeAt(0) & 0xff)),
    readable: new ReadableStream({ start: (c) => { ctrl = c; } }),
    writable: new WritableStream({ write: (chunk) => { written.push(String.fromCharCode(...chunk)); } }),
    getInfo: () => ({ usbVendorId: 1, usbProductId: 2 }),
    opened: null, async open(o) { this.opened = o; }, async close() { ctrl.close(); },
  };
}
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

test('line splitting, prompt/NUL stripping, about join, ring buffer', async () => {
  const port = fakePort(), s = new SerialLink({ ringSize: 5 });
  const lines = [];
  s.addEventListener('line', (e) => lines.push(e.detail));
  await s.open({ port, baudRate: 38400 });
  assert.equal(port.opened.baudRate, 38400); assert.equal(port.opened.dataBits, 8); assert.equal(port.opened.parity, 'none');
  assert.deepEqual(s.info, { usbVendorId: 1, usbProductId: 2 });
  port.push('[echo=0]\r\n>[MAC=1F3A]\n\r\0\0> 0xff0501033200\r');
  port.push('[about="Sparv RR4 hw=4,\nfw=1.4.2, prot=6"]\r\n');
  port.push('[#DAT:id=1,te=\xe9]\r');       // latin-1 byte survives decoding
  await tick();
  assert.deepEqual(lines.map((l) => l.kind), ['response', 'response', 'ssp', 'response', 'message']);
  assert.equal(lines[1].text, '>[MAC=1F3A]'); assert.equal(lines[1].bracket, '[MAC=1F3A]');
  assert.equal(lines[2].hex, '0xff0501033200');
  assert.equal(lines[3].bracket, '[about="Sparv RR4 hw=4, fw=1.4.2, prot=6"]');
  assert.ok(lines[4].text.includes('é'));
  assert.ok(lines.every((l) => l.dir === 'rx' && typeof l.t === 'number'));
  assert.equal(s.rxLines, 5); assert.equal(s.lines.length, 5);
  port.push('x1\n'); await tick();
  assert.equal(s.lines.length, 5, 'ring buffer capped'); assert.equal(s.lines[0].text, '>[MAC=1F3A]');
  await s.close();
});

test('writes: CRLF + ASCII filter + spacing for text, newline framing for SSP', async () => {
  const port = fakePort(), s = new SerialLink({ textSpacingMs: 60 });
  await s.open({ port });
  const t0 = Date.now();
  await s.writeText('echo=0'); await s.writeSsp('0xff2007'); await s.writeText('mäc');
  const dt = Date.now() - t0;
  assert.deepEqual(port.written, ['echo=0\r\n', '\n0xff2007\n', 'mc\r\n']);
  assert.ok(dt >= 55, `spacing respected (${dt} ms)`);
  assert.equal(s.txLines, 3); assert.deepEqual(s.lines.map((l) => l.dir), ['tx', 'tx', 'tx']);
  await s.close();
  await assert.rejects(s.writeText('x'), /E_PORT_CLOSED/);
});

test('stream end → close event with reason, isSupported false in node', async () => {
  const port = fakePort(), s = new SerialLink();
  const closes = [];
  s.addEventListener('close', (e) => closes.push(e.detail.reason));
  await s.open({ port });
  await port.close(); await tick();
  assert.deepEqual(closes, ['eof']); assert.equal(s.isOpen, false);
  assert.equal(SerialLink.isSupported(), false);
  await assert.rejects(new SerialLink().open({}), /E_NO_WEBSERIAL/);
});
