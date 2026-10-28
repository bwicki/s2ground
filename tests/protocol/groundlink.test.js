// node --test: GroundLink end-to-end against the scripted MockSerial (RR4 + S2): handshake, SSP
// join (NewIdWithRev + ack), discovery with an S2 object, net report, DAT/MET/PK/RES/TXT lines,
// sonde commands, net write with read-back, ephemeris transfer, port loss. Real timers, but the
// timing options are shrunk so the whole file runs in a few seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GroundLink } from '../../src/protocol/index.js';
import { MockSerial } from './mock-serial.js';

const FAST = { timing: { textSpacingMs: 5, responseMs: 150, firstEchoMs: 300, exeAckMs: 150, exeTimeoutMs: 600, exeSpacingMs: 20, sspReplyMs: 300, nameReplyMs: 300, aidReplyMs: 300, joinTimeoutMs: 1500, keepAliveMs: 400, pingReplyMs: 200, probeMs: 200, paramsWaitMs: 500 }, pollSensorsMs: 150 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('until(): timeout'); await sleep(10); } }

async function setup(mockOpts = {}, linkOpts = {}) {
  const mock = new MockSerial(mockOpts);
  const link = new GroundLink({ ...FAST, ...linkOpts });
  const ev = { telemetry: [], packet: [], event: [], line: [], error: [], state: [], progress: [] };
  for (const k of Object.keys(ev)) link.addEventListener(k, (e) => ev[k].push(e.detail));
  return { mock, link, ev };
}

test('connect: handshake, SSP join with revision ack, discovery of RR4 + S2, net via report', async () => {
  const { mock, link, ev } = await setup();
  const rx = await link.connect({ port: mock });
  assert.deepEqual([rx.hw, rx.fw, rx.prot, rx.mac], ['4', '1.4.2', 6, '1F3A']);
  assert.deepEqual(mock.rxText.slice(0, 3), ['echo=0', 'mac', 'about']);
  assert.equal(mock.acked, 7, 'newidAck sent for newidWithRev');
  const s = link.state;
  assert.equal(s.port, 'open'); assert.equal(s.ssp.joined, true); assert.equal(s.ssp.id, 3); assert.equal(s.ssp.central, 1);
  assert.equal(s.ssp.rr4Oid, 1); assert.equal(s.ssp.s2Oid, 2);
  assert.deepEqual(s.net, { frequencyHz: 433900000, timeslots: 6, slotMs: 500, sf: 9, bw: 125000, cr: 5, groundSlot: 500, sampleMs: 1000, maxData: 60, netId: null });
  assert.equal(s.receiver.componentId, 1); assert.equal(s.receiver.utcSyncSource, 5); assert.equal(s.receiver.gnssHasAid, true);
  assert.equal(s.receiver.usb.usbVendorId, 0x0403);
  // S2 status from its SSP report
  assert.equal(s.sonde.id, 12345); assert.equal(s.sonde.md, 1); assert.equal(s.sonde.componentId, 2); assert.equal(s.sonde.name, 'S2_H3-R-B20'); assert.equal(s.sonde.type, 'S2H3-R-B20');
  assert.ok(Math.abs(s.sonde.batV - 4.05) < 1e-6); assert.equal(s.sonde.pr, 96240); assert.equal(s.sonde.powerDbm, 13); assert.equal(s.sonde.txCriterion, 3); assert.deepEqual(s.sonde.conditionText, []);
  // net was pushed to the S2 (spec §5.3 step 5)
  assert.ok(mock.sets.some((x) => x.to === 2 && x.map.has(1201)), 'set net on S2');
  assert.equal(mock.s2.net.freq, 433900000);
  // getVarType negotiated REF105 for net
  assert.equal(link.ls.netSchema, 105);
  // receiver sensor polling (temp/bat) and line events with direction
  await until(() => link.state.receiver.tempC !== null && link.state.receiver.batV !== null, 1500);
  assert.equal(link.state.receiver.tempC, 21.5); assert.equal(link.state.receiver.pa, 96250); assert.equal(link.state.receiver.batV, 4.02);
  assert.ok(ev.line.some((l) => l.dir === 'tx' && l.text === 'echo=0') && ev.line.some((l) => l.dir === 'rx' && l.text.includes('[echo=0]')));
  assert.ok(ev.state.length >= 2, 'state events (opening, open)');
  assert.equal(ev.error.length, 0, ev.error.map((e) => e.message).join());
  // keep-alive ping after idle
  await sleep(600);
  assert.ok(mock.calls.some((c) => c.sym === 24 && c.arg === 3), 'ping with our id');
  assert.equal(link.state.ssp.joined, true);
  await link.disconnect();
  assert.equal(link.state.port, 'closed'); assert.equal(mock.opened, false);
  await sleep(20);
  assert.ok(mock.rxFrames.some((f) => f.name === 'unsub'), 'graceful unsub');
});

test('telemetry: DAT/MET/PK/TXT/ANN lines → records, packets, events; role=6 = receiver data', async () => {
  const { mock, link, ev } = await setup();
  await link.connect({ port: mock });
  link.startSession({ groundAlt: 432, groundPa: 96240 });
  mock.dat({ seq: 10 }); mock.push('[#PK:rs=-71,snr=8,rec=0,hderr=0,bderr=0,crc=S]');
  mock.push('[#MET:id=12345,seq=11,md=2,pa=95500,te=10,hu=55,spd=3,ang=200,rise=2.5,su=4.0,rs=-72,snr=8,te1=10.5,hu1=54,spd1=2.9,ang1=199]');
  mock.push('[#DAT:role=6,lat=47.44,lon=8.56,alt=433,pa=96250,su=4.1,te=21,sats=11]');
  mock.push('[#ANN:id=12345,sid=2]'); mock.push('[#TXT:id=12345:w(1)]');
  mock.push('junk [#DAT:id=999,seq=1,md=1,pa=90000,te=1,hu=1] (other sonde, ignored by lockSondeId)');
  await until(() => ev.event.length >= 2, 1500);
  await sleep(50);
  assert.deepEqual(ev.telemetry.map((r) => r.src), ['DAT', 'INF', 'MET']);
  assert.equal(ev.telemetry[0].altAgl, 0); assert.equal(ev.telemetry[0].lat, 47.4433); assert.ok(Math.abs(ev.telemetry[0].rssi - 79 / 90) < 1e-9);
  assert.equal(ev.telemetry[1].t, ev.telemetry[2].t - 1000, 'INF spaced by net.sampleMs');
  assert.ok(ev.telemetry[2].altAgl > 50 && ev.telemetry[2].altAgl < 80, `MET altAgl ${ev.telemetry[2].altAgl}`);
  assert.ok(ev.packet.some((p) => p.rs === -71 && p.snr === 8));
  assert.deepEqual(ev.event.map((e) => e.type), ['announce', 'wireHeated']);
  const s = link.state;
  assert.equal(s.receiver.lat, 47.44); assert.equal(s.receiver.gnssFix, true); assert.equal(s.receiver.sats, 11); assert.equal(s.receiver.pa, 96250);
  assert.equal(s.sonde.id, 12345); assert.equal(s.sonde.md, 2); assert.ok(s.sonde.agl > 50);
  assert.ok(s.lastRxT > 0 && s.rxLines > 10 && s.txLines > 3);
  assert.ok(link.lines.length > 10 && link.lines.every((l) => l.dir && typeof l.text === 'string' && l.t));
  link.stopSession();
  await link.disconnect();
});

test('sonde commands over the text channel: readSonde, cutdown altitude, wire test, cutdown, beep, mode, exe errors', async () => {
  const { mock, link, ev } = await setup();
  await link.connect({ port: mock });
  const info = await link.readSonde();
  assert.equal(info.fwver, '312'); assert.equal(info.role, 1); assert.equal(info.cutAltAgl, null, '65535 = none'); assert.equal(info.id, 12345);
  assert.ok(mock.exeLog.includes('params=06,13,15,17'));
  const cut = await link.setCutdownAltitude(1600, 96240);
  assert.equal(cut, 1600, 'read back via params=15');
  const relAp = mock.exeLog.find((c) => c.startsWith('relAP='));
  assert.match(relAp, /^relAP=\d+:1600$/);
  const half = Number(relAp.split('=')[1].split(':')[0]);
  assert.ok(half > 38000 && half < 42000, `release pressure/2 = ${half} (≈ 80.6 kPa / 2)`);
  assert.equal(link.state.sonde.cutAltAgl, 1600);
  const wt = await link.ledAndWireTest();
  assert.equal(wt.primaryOk, true); assert.equal(wt.secondaryOk, false); assert.equal(wt.ledOk, true); assert.ok(wt.raw.includes('R(S57B411C0L1)'));
  assert.ok(mock.rxText.includes('12345.cmd=wires'), 'wires is one-way');
  assert.ok(ev.event.some((e) => e.type === 'wireTest'));
  const res = await link.cutdown();
  assert.equal(res, 'Burning'); assert.ok(mock.exeLog.includes('relBal=150'), 'on the ground → relBal=150');
  await until(() => ev.event.some((e) => e.type === 'cutdown'), 1500);
  const c = ev.event.find((e) => e.type === 'cutdown');
  assert.equal(c.data.by, 'manual'); assert.equal(link.state.sonde.md, 7);
  mock.s2.md = 2; link.ls.sonde.md = 2;
  await link.cutdown(); assert.equal(mock.exeLog.at(-1), 'mode=7', 'in flight → mode=7 for an S2 (3.11.8)');
  mock.s2.md = 2; link.ls.sonde.md = 2; link.opts.s2CutdownViaMode7 = false;
  await link.cutdown(); assert.equal(mock.exeLog.at(-1), 'relBal', 'in flight → relBal (3.8.0 behaviour)');
  assert.equal(await link.cutdownSecondary(), 'C(A1234T56)', 'relGnd confirmed by a cut-down report');
  mock.relGndReply = 'OK relGnd';
  await assert.rejects(link.cutdownSecondary(), /E_CUTDOWN2_UNCONFIRMED/, '3.11.7 check: RES must start with C');
  link.opts.strictRelGnd = false; assert.equal(await link.cutdownSecondary(), 'OK relGnd');
  assert.equal(await link.setLandedBehaviour(2), 'OK findme=2'); assert.ok(mock.exeLog.includes('findme=2'));
  await assert.rejects(link.setLandedBehaviour(7), /E_ARG/);
  assert.equal(await link.beep(), 'OK'); assert.ok(mock.exeLog.includes('beep=2900'));
  await link.setMode(5); assert.ok(mock.exeLog.includes('mode=5'));
  assert.equal(await link.sendExe('ver'), 'OK ver');
  await assert.rejects(link.sendExe('busy'), /E_BUSY/);
  await assert.rejects(link.sendExe('fail'), /E_SONDE_ERROR/);
  await assert.rejects(link.sendExe('silent'), /E_TIMEOUT_RADIO/);
  assert.ok(ev.error.length >= 3, 'rejections are also emitted as error events');
  await link.disconnect();
  await assert.rejects(link.beep(), /E_PORT_CLOSED/);
});

test('writeNet: text settings + SSP set net, read-back, push to S2; pairSonde; gnss aiding', async () => {
  const { mock, link, ev } = await setup();
  await link.connect({ port: mock });
  const net = await link.writeNet({ frequencyHz: 434100000, timeslots: 8, sf: 10, cr: 6, bw: 250000 });
  assert.equal(net.frequencyHz, 434100000); assert.equal(net.timeslots, 8); assert.equal(net.sf, 10); assert.equal(net.cr, 6); assert.equal(net.bw, 250000);
  assert.ok(mock.rxText.includes('frequency=434100000') && mock.rxText.includes('ts=8'));
  const rr4Set = mock.sets.filter((x) => x.to === 1).at(-1).map.get(1201);
  assert.equal(rr4Set.loraSpreadingFactor, 10); assert.equal(rr4Set.loraCodingRate, 2); assert.equal(rr4Set.loraBandwidth, 1); assert.equal(rr4Set.freq, 434100000);
  assert.equal(mock.s2.net.freq, 434100000, 'pushed to S2');
  await assert.rejects(link.writeNet({ frequencyHz: 300e6 }), /E_FREQ_RANGE/);
  await assert.rejects(link.writeNet({ frequencyHz: 395e6 }), /E_FREQ_RANGE/, '390–400 MHz only with the extended span');
  link.opts.freqRange = 'extended';
  const n395 = await link.writeNet({ frequencyHz: 395e6 }); assert.equal(n395.frequencyHz, 395000000);
  link.opts.freqRange = 'default';
  await link.pairSonde(); assert.ok(mock.rxText.includes('annNet'));
  const n = await link.gnssAidToSonde();
  assert.ok(n >= 3, `chunks ${n}`); assert.equal(mock.aidChunks, n); assert.equal(mock.aidCalls, 3, 'gnssGetAid until the empty blob');
  assert.ok(ev.progress.some((p) => p.phase === 'download') && ev.progress.some((p) => p.phase === 'upload' && p.done === p.total));
  await link.disconnect();
});

test('no SSP (older receiver / join timeout): text fallback for net, sonde from telemetry only', async () => {
  const { mock, link, ev } = await setup({ ssp: false });
  const t0 = Date.now();
  await link.connect({ port: mock });
  assert.ok(Date.now() - t0 >= 1400, 'waited for the join timeout');
  assert.ok(ev.error.some((e) => /E_SSP_JOIN_TIMEOUT/.test(e.message)));
  const s = link.state;
  assert.equal(s.port, 'open'); assert.equal(s.ssp.joined, false); assert.equal(s.sonde, null);
  assert.equal(s.net.frequencyHz, 433900000); assert.equal(s.net.timeslots, 6); assert.equal(s.net.sf, null);
  mock.dat({ seq: 1, md: 0, su: 3.99 });
  await until(() => link.state.sonde !== null);
  assert.equal(link.state.sonde.id, 12345); assert.equal(link.state.sonde.batV, 3.99); assert.equal(link.state.sonde.componentId, null);
  const wt = await link.ledAndWireTest(); assert.equal(wt.primaryOk, true);
  await assert.rejects(link.gnssAidToSonde(), /E_SSP_NOT_JOINED/);
  await link.disconnect();
  const { mock: m2, link: l2 } = await setup({ ssp: false }, { requireSsp: true });
  await assert.rejects(l2.connect({ port: m2 }), /E_SSP_JOIN_TIMEOUT/);
  assert.equal(l2.state.port, 'closed');
});

test('generic Map reports (spec §8 Q5), plain newid, S2 appearing later, port loss', async () => {
  const { mock, link, ev } = await setup({ mapStyle: 'map', withRev: false, withS2: false });
  await link.connect({ port: mock });
  assert.equal(link.state.net.frequencyHz, 433900000); assert.equal(link.state.sonde, null); assert.equal(mock.acked, undefined);
  mock.o.withS2 = true; mock._report(1, [[13, [1, 2]]]);                      // components report: S2 came online
  await until(() => link.state.ssp.s2Oid === 2 && link.state.sonde && link.state.sonde.id === 12345);
  mock._report(1, [[13, [1]]]);                                                 // and went away again
  await until(() => link.state.ssp.s2Oid === null);
  assert.equal(link.state.sonde.componentId, null, 'SSP identity dropped, telemetry info kept');
  assert.equal(await link.sendExe('x'), 'OK x', 'id still known → text commands keep working');
  mock.pushRaw(Uint8Array.from([0x3e, 0x00, 0x30, 0x78, 0x5a, 0x5a, 0x0a]));    // "> \0 0xZZ" → warn, reader loop survives
  mock.push('0x0399');                                                          // unknown message → warn, no crash
  mock.push('[#DAT:id=12345,seq=2,md=1,pa=96000,te=5,hu=50]');
  await until(() => ev.telemetry.length === 1);
  await mock.close();                                                           // device unplugged
  await until(() => link.state.port === 'lost');
  assert.ok(ev.error.some((e) => /E_PORT_LOST/.test(e.message)));
});

test('keep-alive: ping failure → link lost → re-probe, rejoin and rediscover', async () => {
  const { mock, link, ev } = await setup();
  await link.connect({ port: mock });
  const pings = () => mock.calls.filter((c) => c.sym === 24).length;
  await until(() => pings() >= 1, 1500);
  mock.muted = true;
  await until(() => link.state.ssp.joined === false, 2500);
  assert.equal(link.state.ssp.rr4Oid, null); assert.equal(link.state.sonde.componentId, null);
  mock.muted = false; mock.joined = false;
  await until(() => link.state.ssp.joined && link.state.ssp.rr4Oid === 1 && link.state.ssp.s2Oid === 2, 3000);
  assert.equal(link.state.net.sf, 9);
  assert.equal(link.state.port, 'open');
  assert.equal(ev.error.length, 0);
  await link.disconnect();
});
