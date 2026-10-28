// node --test: the 3.11.8 deltas (docs/protocol/CHANGES-3.11.8.md) – decimal radio quality keys,
// jam/spoof flags, the frequency span table, sspDefaultSet auto-sync, S2 role change, WiFi settings
// over SSP and the WebSocket transport against a mock RR4 WebSocket server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GroundLink, parseBracketLine, FREQ_RANGES, checkFrequency, ipAddrToString, WebSocketLink, wsUrl, encodeFrame, decodeFrame } from '../../src/protocol/index.js';
import { rssiFromParams } from '../../src/protocol/lines.js';
import { TelemetryBuilder } from '../../src/protocol/telemetry.js';
import { Typed, REF, plain } from '../../src/protocol/ssp-bin.js';
import { MockSerial } from './mock-serial.js';
import { MockWsRr4 } from './mock-ws.js';

const FAST = { timing: { textSpacingMs: 5, responseMs: 150, firstEchoMs: 300, exeAckMs: 150, exeTimeoutMs: 600, exeSpacingMs: 20, sspReplyMs: 300, nameReplyMs: 300, aidReplyMs: 300, joinTimeoutMs: 1500, keepAliveMs: 400, pingReplyMs: 200, probeMs: 200, paramsWaitMs: 500 }, pollSensorsMs: 150 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('until(): timeout'); await sleep(10); } }

test('bracket parser: radio quality parameters with decimals (3.11.3), jam/spoof keys', () => {
  const m = parseBracketLine('[#DAT:id=12345,seq=3,md=2,rs=-71.5,snr=9.25,rec=1.5,q=4a,pa=96240.0,te=12.30,jam=1,spoof=2,afc=15.0]');
  assert.equal(m.params.rs, -71.5); assert.equal(m.params.snr, 9.25); assert.equal(m.params.rec, 1.5);
  assert.equal(m.params.q, 0x4a); assert.equal(m.params.pa, 96240); assert.equal(m.params.jam, 1); assert.equal(m.params.spoof, 2); assert.equal(m.params.afc, 15);
  assert.ok(Math.abs(rssiFromParams(m.params) - (-71.5 + 9.25 + 140) / 90) < 1e-9, 'rssi from decimal rs/snr');
  // integers still integers, text stays text
  const n = parseBracketLine('[#PK:rssi=-70,rec=3,hderr=0,crc=S]');
  assert.equal(n.params.rssi, -70); assert.equal(n.params.rec, 3); assert.equal(n.params.crc, 'S');
});

test('telemetry: jam/spoof in records and a gnssIntegrity event on change (feature flag)', () => {
  const tb = new TelemetryBuilder();
  const msg = parseBracketLine('[#DAT:id=1,seq=1,md=2,pa=90000,te=1,hu=50,alt=1000,jam=0,spoof=1]'); msg.t = 1000;
  const [rec] = tb.records(msg, 1000);
  assert.equal(rec.jam, 0); assert.equal(rec.spoof, 1);
  const ev = tb.integrityEvent(msg, 1000);
  assert.equal(ev.type, 'gnssIntegrity'); assert.equal(ev.data.spoofing, 'suspected'); assert.equal(ev.data.jamming, 'none');
  assert.equal(tb.integrityEvent(msg, 1001), null, 'no change → no event');
  const msg2 = parseBracketLine('[#DAT:id=1,seq=2,md=2,pa=90000,jam=2,spoof=0]');
  assert.equal(tb.integrityEvent(msg2, 1002).data.jamming, 'detected');
  const off = new TelemetryBuilder({ gnssIntegrityEvents: false });
  assert.equal(off.integrityEvent(msg, 1000), null);
  assert.equal(tb.integrityEvent(parseBracketLine('[#DAT:id=1,seq=3,pa=1]'), 1003), null, 'keys absent → nothing');
});

test('frequency spans (spec §5.4, 3.11.8): default 400–440, extended 390–440, custom; E_FREQ_RANGE before sending', async () => {
  assert.equal(checkFrequency(433.9e6), 433900000);
  assert.throws(() => checkFrequency(395e6), /E_FREQ_RANGE/);
  assert.equal(checkFrequency(395e6, 'extended'), 395000000);
  assert.throws(() => checkFrequency(389.999e6, 'extended'), /E_FREQ_RANGE/);
  assert.throws(() => checkFrequency(440.001e6, 'extended'), /E_FREQ_RANGE/);
  assert.equal(checkFrequency(445e6, { minHz: 400e6, maxHz: 450e6 }), 445000000);
  assert.throws(() => checkFrequency(NaN), /E_FREQ_RANGE/);
  assert.deepEqual(Object.keys(FREQ_RANGES), ['default', 'extended', 'legacy380']);
  // nothing is sent when the check fails
  const mock = new MockSerial(); const link = new GroundLink(FAST);
  await link.connect({ port: mock });
  const sent = mock.rxText.length;
  await assert.rejects(link.writeNet({ frequencyHz: 300e6, timeslots: 9 }), /E_FREQ_RANGE/);
  assert.equal(mock.rxText.length, sent, 'no text command went out');
  await link.disconnect();
});

test('sspDefaultSet (spec §5.5a): RR4 with auto-sync gets the tuple once, the PC does not push net to the S2', async () => {
  const mock = new MockSerial({ defaultSet: true }); const link = new GroundLink({ ...FAST, s2Defaults: { txCriterion: 3, powerBeforeLaunchDbm: 0 } });
  await link.connect({ port: mock });
  assert.ok(link.state.autoSync && link.state.autoSync.written, 'default set written');
  assert.equal(link.state.autoSync.schema, REF.DEFAULT_SET);
  assert.ok(mock.defaultSet, 'RR4 stored it');
  const [opt, map] = mock.defaultSet;
  assert.equal(plain(map.get(1201)).freq, 433900000); assert.equal(plain(map.get(1226)), 3); assert.equal(plain(map.get(1239)), 0);
  assert.equal(opt, 1 << 2, 'powerBeforeLaunch (3rd entry) flagged optional');
  assert.ok(!mock.sets.some((x) => x.to === 2 && x.map.has(1201)), 'no direct set net on the S2');
  assert.equal(mock.s2.net.freq, 433900000, 'the RR4 synced the S2');
  // a net change refreshes the default set instead of pushing to the S2
  const n = await link.writeNet({ frequencyHz: 434.1e6 });
  assert.equal(n.frequencyHz, 434100000);
  assert.equal(plain(mock.defaultSet[1].get(1201)).freq, 434100000);
  assert.ok(!mock.sets.some((x) => x.to === 2 && x.map.has(1201)));
  // wire format: Typed(116, [U64, NameMap]) round-trips through our codec
  const hex = encodeFrame({ to: 1, name: 'set', ticketed: true, body: { from: 3, tk: 1, map: new Map([[477, new Typed(116, [4, new Map([[1226, new Typed(2, 3)]])])]]) } });
  const f = decodeFrame(hex);
  assert.equal(f.name, 'set'); const v = plain(f.body.map.get(477)); assert.equal(v[0], 4); assert.equal(v[1].get(1226), 3);
  await link.disconnect();
});

test('older RR4 without sspDefaultSet: detection says no, the 3.8.0 push to the S2 stays', async () => {
  const mock = new MockSerial(); const link = new GroundLink(FAST);
  await link.connect({ port: mock });
  assert.equal(link.state.autoSync, false);
  assert.ok(mock.sets.some((x) => x.to === 2 && x.map.has(1201)), 'set net on S2');
  await link.disconnect();
});

test('S2 role (3.11.8): subscribed, settable 1..4, nack 5 → E_NO_ROLE', async () => {
  const mock = new MockSerial(); const link = new GroundLink(FAST);
  await link.connect({ port: mock });
  assert.equal(link.state.sonde.role, 1);
  assert.equal(await link.setRole(4), 4); assert.equal(mock.s2.role, 4); assert.equal(link.state.sonde.role, 4);
  await assert.rejects(link.setRole(6), /E_ARG/); await assert.rejects(link.setRole(9), /E_ARG/);
  await link.disconnect();
});

test('WiFi settings over SSP (spec §1.8): read, write + wifiApply, ipAddr Uint32 → dotted', async () => {
  assert.equal(ipAddrToString(0xc0a80142), '192.168.1.66'); assert.equal(ipAddrToString(0), ''); assert.equal(ipAddrToString('10.0.0.5'), '10.0.0.5'); assert.equal(ipAddrToString(null), '');
  const mock = new MockSerial({ wifi: true }); const link = new GroundLink(FAST);
  await link.connect({ port: mock });
  const w = await link.readWifi();
  assert.deepEqual(w, { enabled: false, ap: true, apSsid: 'RR4-1F3A', apPwd: 'sparv1234', clientSsid: '', clientPwd: '', ipAddr: '' });
  const w2 = await link.writeWifi({ mode: 'client', clientSsid: 'Hangar', clientPwd: 'secret' });
  assert.equal(mock.wifiApplied, 1);
  assert.equal(mock.wifi[1507], true); assert.equal(mock.wifi[1504], false); assert.equal(mock.wifi[1500], 'Hangar'); assert.equal(mock.wifi[1501], 'secret');
  assert.equal(w2.enabled, true); assert.equal(w2.ap, false); assert.equal(w2.ipAddr, '192.168.1.66');
  assert.equal(link.state.receiver.ipAddr, '192.168.1.66', 'ipAddr report reached the receiver state');
  await link.disconnect();
  // RR4 without WiFi variables
  const mock2 = new MockSerial(); const link2 = new GroundLink(FAST);
  await link2.connect({ port: mock2 });
  await assert.rejects(link2.readWifi(), /E_NO_WIFI/);
  await link2.disconnect();
});

test('WebSocketLink framing: binary frame = TO + SSP message, probe every 2 s, text frames become lines', async () => {
  assert.equal(wsUrl({ host: '192.168.4.1' }), 'ws://192.168.4.1/');
  assert.equal(wsUrl({ host: '192.168.4.1', port: 81, path: 'ws' }), 'ws://192.168.4.1:81/ws');
  assert.equal(wsUrl({ url: 'wss://rr4.local/x' }), 'wss://rr4.local/x');
  assert.throws(() => wsUrl({}), /E_WS_URL/);
  const srv = new MockWsRr4({ textChannel: true }); const ep = await srv.listen();
  const ws = new WebSocketLink({ openTimeoutMs: 2000 });
  assert.equal(ws.probeMs, 2000);
  const lines = []; ws.addEventListener('line', (e) => lines.push(e.detail));
  await ws.open(ep);
  assert.equal(ws.isOpen, true); assert.equal(ws.info.transport, 'wifi'); assert.equal(ws.info.url, `ws://127.0.0.1:${ep.port}/ws`);
  // our CInfo probe as one binary frame: ff 04 03 a6 00 01000000 00 00 00 00 03 06 'python'
  await ws.writeSsp('0xff0403a60001000000000000000306707974686f6e');
  await until(() => srv.binaryFramesRx === 1 && srv.rxFrames.length === 1);
  assert.equal(srv.rxFrames[0].name, 'cinfo'); assert.equal(srv.rxFrames[0].to, 0xff); assert.equal(srv.rxFrames[0].body.compatibility, 3);
  await until(() => lines.some((l) => l.kind === 'ssp'));
  const f = decodeFrame(lines.find((l) => l.kind === 'ssp').hex);
  assert.equal(f.name, 'newidWithRev'); assert.equal(f.body.id, 3);
  // text frames → classified lines (only if the RR4 has a text channel over WiFi – mock says yes here)
  await ws.writeText('about');
  await until(() => lines.some((l) => l.kind === 'response'));
  assert.ok(lines.find((l) => l.kind === 'response').bracket.includes('Sparv RR4'));
  assert.equal(srv.textFramesRx[0], 'about\r\n');
  assert.ok(ws.textFramesSeen >= 1 && ws.binaryFramesSeen >= 1);
  assert.ok(ws.lines.some((l) => l.dir === 'tx' && l.text === 'about'));
  // connection loss → 'close' with a reason
  const closed = new Promise((r) => ws.addEventListener('close', (e) => r(e.detail.reason)));
  srv.dropClient();
  assert.match(await closed, /lost|closed/);
  assert.equal(ws.isOpen, false);
  await srv.stop();
});

test('GroundLink over WiFi: SSP only (no text channel) – join, discovery, net via SSP, text features disabled', async () => {
  const srv = new MockWsRr4({ textChannel: false }); const ep = await srv.listen();
  const link = new GroundLink({ ...FAST, wifiTextProbe: true });
  const ev = { telemetry: [], event: [], error: [] };
  for (const k of Object.keys(ev)) link.addEventListener(k, (e) => ev[k].push(e.detail));
  const rx = await link.connect({ wifi: ep });
  const s = link.state;
  assert.equal(s.transport, 'wifi'); assert.equal(s.textChannel, false); assert.equal(rx.transport, 'wifi'); assert.equal(rx.mac, null);
  assert.equal(s.ssp.joined, true); assert.equal(s.ssp.rr4Oid, 1); assert.equal(s.ssp.s2Oid, 2);
  assert.equal(s.net.frequencyHz, 433900000, 'net from the SSP report');
  assert.equal(s.sonde.id, 12345); assert.equal(s.sonde.md, 1);
  assert.equal(s.receiver.usb.url, `ws://127.0.0.1:${ep.port}/ws`);
  assert.ok(srv.textFramesRx.length >= 1, 'echo=0 was tried once as a text frame');
  assert.equal(srv.rxText.length, 0, 'the mock has no text channel → nothing parsed');
  // text-channel features reject cleanly, SSP features work
  await assert.rejects(link.cutdown(), /E_NO_TEXT_CHANNEL/);
  await assert.rejects(link.sendExe('ver'), /E_NO_TEXT_CHANNEL/);
  await assert.rejects(link.pairSonde(), /E_NO_TEXT_CHANNEL/);
  assert.equal(await link.setRole(3), 3);
  const net = await link.writeNet({ sf: 10, frequencyHz: 434.1e6 });      // everything via one SSP set net
  assert.equal(net.sf, 10); assert.equal(net.frequencyHz, 434100000); assert.equal(srv.net.freq, 434100000);
  const info = await link.readSonde();                                     // SSP part only, no params= query
  assert.equal(info.name, 'S2_H3-R-B20');
  assert.equal(srv.exeLog.length, 0);
  // the mock RR4 is dropped → port lost
  srv.dropClient();
  await until(() => link.state.port === 'lost', 3000);
  assert.ok(ev.error.some((e) => /E_PORT_LOST/.test(e.message)));
  await srv.stop();
});

test('GroundLink over WiFi with a text channel: full handshake and telemetry as over USB', async () => {
  const srv = new MockWsRr4({ textChannel: true }); const ep = await srv.listen();
  const link = new GroundLink({ ...FAST, transport: 'wifi', wifi: { host: ep.host, port: ep.port, path: '/ws' } });
  const ev = { telemetry: [], event: [] };
  for (const k of Object.keys(ev)) link.addEventListener(k, (e) => ev[k].push(e.detail));
  const rx = await link.connect();
  assert.equal(link.state.textChannel, true); assert.equal(rx.mac, '1F3A'); assert.equal(rx.prot, 6);
  srv.dat({ rs: -70.25, snr: 8.5, jam: 1 });
  await until(() => ev.telemetry.length === 1);
  assert.equal(ev.telemetry[0].rs, -70.25); assert.equal(ev.telemetry[0].jam, 1);
  assert.ok(ev.event.some((e) => e.type === 'gnssIntegrity' && e.data.jamming === 'suspected'));
  assert.equal(await link.beep(), 'OK');
  await link.disconnect();
  assert.equal(link.state.port, 'closed');
  await srv.stop();
});

test('WiFi connect failures: wrong path / nobody listening → E_WS_*, port stays closed', async () => {
  const srv = new MockWsRr4(); const ep = await srv.listen();
  const link = new GroundLink(FAST);
  await assert.rejects(link.connect({ wifi: { host: ep.host, port: ep.port, path: '/nope', openTimeoutMs: 1500 } }), /E_WS_/);
  assert.equal(link.state.port, 'closed');
  await srv.stop();
  await assert.rejects(link.connect({ wifi: { host: '127.0.0.1', port: ep.port, path: '/ws', openTimeoutMs: 1500 } }), /E_WS_/);
  assert.equal(link.state.port, 'closed');
});
