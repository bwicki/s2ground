// node --test: text command queue timing (spec §1.3, §1.6, §5.8) with mocked timers – one in flight,
// 0.4 s response wait + retries, ≥ 1 s spacing per sonde, RES parts, TIM, Busy, Error.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { TextProto } from '../../src/protocol/text-proto.js';
import { classifyLine } from '../../src/protocol/lines.js';

/** Minimal stand-in for SerialLink: records writes, lets the test inject rx lines. */
class FakeSerial extends EventTarget {
  constructor() { super(); this.written = []; }
  async writeText(t) { this.written.push(t); }
  rx(text) { const c = classifyLine(text); this.dispatchEvent(new CustomEvent('line', { detail: { dir: 'rx', text, t: Date.now(), kind: c.kind, hex: c.hex, bracket: c.bracket } })); }
}
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

test('one command in flight, response resolves, timeout rejects after retries', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = new FakeSerial(), tp = new TextProto(s);
  const p1 = tp.command('mac'), p2 = tp.command('about');
  await flush();
  assert.deepEqual(s.written, ['mac'], 'second command waits');
  s.rx('[MAC=1F3A]');
  assert.equal(await p1, 'MAC=1F3A');
  await flush();
  assert.deepEqual(s.written, ['mac', 'about']);
  mock.timers.tick(399); await flush();
  s.rx('[about="Sparv RR4 hw=4, fw=1.4.2, prot=6"]');
  assert.match(await p2, /^about=/);
  // retries: 3 sends in total, then E_TIMEOUT
  const p3 = tp.command('frequency', { retries: 2 });
  await flush(); mock.timers.tick(400); await flush(); mock.timers.tick(400); await flush(); mock.timers.tick(400); await flush();
  await assert.rejects(p3, /E_TIMEOUT/);
  assert.equal(s.written.filter((x) => x === 'frequency').length, 3);
  // an unsolicited response while nothing is in flight is ignored
  s.rx('[stray]');
  const p4 = tp.command('ts'); await flush(); s.rx('[ts=6]'); assert.equal(await p4, 'ts=6');
  mock.timers.reset(); t.diagnostic('ok');
});

test('query / setting parse and verify', async () => {
  const s = new FakeSerial(), tp = new TextProto(s);
  const q = tp.query('frequency'); await flush(); s.rx('[frequency=433900000]'); assert.equal(await q, '433900000');
  const st = tp.setting('ts', 6); await flush(); s.rx('[ts=6]'); assert.equal(await st, '6');
  const bad = tp.setting('ts', 7); await flush(); s.rx('[Error: nope]'); await assert.rejects(bad, /E_SET_FAILED/);
  const mis = tp.setting('ts', 8); await flush(); s.rx('[ts=6]'); await assert.rejects(mis, /E_SET_MISMATCH/);
});

test('sonde exe queue: ack, RES parts, ≥ 1 s spacing, TIM, Busy, Error, oneway', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = new FakeSerial(), tp = new TextProto(s);
  const a = tp.exe(123, 'relBal'); await flush();
  assert.deepEqual(s.written, ['123.exe=relBal']);
  s.rx('[123.exe=relBal]'); await flush();                       // RR4 ack
  const b = tp.exe(123, 'beep=2900'); await flush();
  assert.equal(s.written.length, 1, 'second command to the same sonde waits for the RES');
  s.rx('[#RES:q=70,part=1:Burn]'); s.rx('[#RES:q=70:ing]');
  assert.equal(await a, 'Burning');
  await flush(); assert.equal(s.written.length, 1, 'spacing: not before 1 s since the last send');
  mock.timers.tick(1000); await flush(3);
  assert.deepEqual(s.written[1], '123.exe=beep=2900');
  s.rx('[123.exe=beep=2900]'); await flush(); s.rx('[#TIM:]');
  await assert.rejects(b, /E_TIMEOUT_RADIO/);
  mock.timers.tick(1000); await flush(3);
  const c = tp.exe(123, 'mode=5'); await flush(3); s.rx('[123.exe=mode=5]'); await flush(); s.rx('[#RES:q=1:Busy]'); await assert.rejects(c, /E_BUSY/);
  mock.timers.tick(1000); await flush(3);
  const d = tp.exe(123, 'wires', { oneway: true }); await flush(3); assert.equal(s.written.at(-1), '123.cmd=wires'); s.rx('[123.cmd=wires]'); assert.equal(await d, '');
  mock.timers.tick(1000); await flush(3);
  const e = tp.exe(123, 'relAP=1:2'); await flush(3); s.rx('[123.exe=relAP=1:2]'); await flush(); s.rx('[#RES:q=1:Error: bad]'); await assert.rejects(e, /E_SONDE_ERROR/);
  mock.timers.tick(1000); await flush(3);
  const f = tp.exe(123, 'silent'); await flush(3); s.rx('[123.exe=silent]'); await flush(); mock.timers.tick(8000); await flush();
  await assert.rejects(f, /E_TIMEOUT_RADIO/);
  mock.timers.tick(1000); await flush(3);
  const g = tp.exe(123, 'x'); await flush(3); s.rx('[Error: no such sonde]'); await assert.rejects(g, /E_RR4/);
  await assert.rejects(tp.exe('abc', 'x'), /E_NO_SONDE/);
  mock.timers.reset();
});

test('RES routing by id when two sondes have commands pending', async () => {
  const s = new FakeSerial(), tp = new TextProto(s, { exeSpacingMs: 0 });
  const a = tp.exe(1, 'ver'), b = tp.exe(2, 'ver'); await flush(3);
  s.rx('[1.exe=ver]'); await flush(3); s.rx('[2.exe=ver]'); await flush(3);
  s.rx('[#RES:id=2,q=1:two]'); assert.equal(await b, 'two');
  s.rx('[#RES:q=1:one]'); assert.equal(await a, 'one');
});
