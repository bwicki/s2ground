// node --test: DAT/MET → TelemetryRecord conversions (spec §5.10, INTERFACE §2): te wrap, rssi
// normalisation, pressure altitude (ISA shift and hypsometric), dew point, MET history expansion
// with pressure interpolation, TXT/ANN/TIM events and the wire-test decoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryBuilder, decodeWireTest } from '../../web/src/protocol/telemetry.js';
import { parseBracketLine } from '../../web/src/protocol/lines.js';
import { isaPressure } from '../../web/src/util/format.js';

const msg = (line, t) => ({ ...parseBracketLine(line), t });

test('DAT → record: fields, te wrap, rssi, dew point, no session → alt = gpsAlt', () => {
  const tb = new TelemetryBuilder();
  const [r] = tb.records(msg('[#DAT:id=12345,seq=5,md=1,lat=47.4433,lon=8.5617,alt=440.2,pa=96240,te=655.10,hu=71.0,spd=1.2,ang=230,rise=0.1,su=4.05,rs=-70,snr=9,sats=9,rec=2,tei=22.5]', 1000));
  assert.equal(r.src, 'DAT'); assert.equal(r.sondeId, 12345); assert.equal(r.seq, 5); assert.equal(r.md, 1); assert.equal(r.t, 1000);
  assert.equal(r.te, -0.26); assert.equal(r.hu, 71); assert.equal(r.pa, 96240); assert.equal(r.gpsAlt, 440.2); assert.equal(r.alt, 440.2); assert.equal(r.altAgl, null);
  assert.ok(Math.abs(r.rssi - 79 / 90) < 1e-9); assert.equal(r.rs, -70); assert.equal(r.snr, 9); assert.equal(r.rec, 2); assert.equal(r.sats, 9); assert.equal(r.tei, 22.5);
  assert.ok(r.td < r.te && r.td > -6, `dew point ${r.td}`); assert.ok(r.raw.startsWith('[#DAT:'));
  const [z] = tb.records(msg('[#DAT:id=12345,seq=6,md=0,lat=0,lon=0,pa=96240,te=10,hu=50]', 2000));
  assert.equal(z.lat, null); assert.equal(z.lon, null); assert.equal(z.gpsAlt, null); assert.equal(z.alt, null); assert.equal(z.rssi, null);
});

test('pressure altitude: ISA shift referenced to ground, hypsometric with measured T', () => {
  const tb = new TelemetryBuilder();
  tb.startSession({ groundAlt: 432, groundPa: 96240 });
  const [g] = tb.records(msg('[#DAT:id=1,seq=1,md=1,pa=96240,te=12,hu=50,alt=445]', 1000));
  assert.equal(g.alt, 432, 'ground pressure maps to ground altitude'); assert.equal(g.altAgl, 0);
  const pa1500 = Math.round(isaPressure(432 + 1500) * (96240 / isaPressure(432)));
  const [r] = tb.records(msg(`[#DAT:id=1,seq=2,md=2,pa=${pa1500},te=2,hu=50]`, 61000));
  assert.ok(Math.abs(r.altAgl - 1500) < 12, `ISA shift ${r.altAgl}`);
  assert.ok(Math.abs(r.rise - 1500 / 60) < 0.3, `rise fallback ${r.rise}`);
  const hy = new TelemetryBuilder({ altMethod: 'hypso' });
  hy.startSession({ groundAlt: 432, groundPa: 96240 });
  const [h] = hy.records(msg('[#DAT:id=1,seq=1,md=2,pa=90000,te=12,hu=50]', 1000));
  // Δz = R·T̄/g · ln(p0/p1) with T̄ = 285.15 K → 561.9 m
  assert.ok(Math.abs(h.altAgl - 287.05 * 285.15 / 9.80665 * Math.log(96240 / 90000)) < 0.5, `hypso ${h.altAgl}`);
  hy.stopSession();
  const [n] = hy.records(msg('[#DAT:id=1,seq=2,md=2,pa=90000,te=12,hu=50]', 2000));
  assert.equal(n.alt, null);
});

test('MET expansion: INF records spaced by the sampling interval, pressure interpolated (≤ 22 s)', () => {
  const tb = new TelemetryBuilder({ sampleMs: 1000 });
  tb.startSession({ groundAlt: 432, groundPa: 96240 });
  tb.records(msg('[#DAT:id=1,seq=1,md=2,pa=96000,te=12,hu=50]', 100000));
  const recs = tb.records(msg('[#MET:id=1,seq=2,md=2,pa=95500,te=10,hu=55,spd=3,ang=200,te1=10.5,hu1=54,spd1=2.9,ang1=199,te2=11,hu2=53,spd2=2.8,ang2=198,te3=11.5,hu3=52,spd3=2.7,ang3=197]', 105000));
  assert.equal(recs.length, 4);
  assert.deepEqual(recs.map((r) => r.src), ['INF', 'INF', 'INF', 'MET']);
  assert.deepEqual(recs.map((r) => r.t), [102000, 103000, 104000, 105000]);
  assert.deepEqual(recs.map((r) => r.te), [11.5, 11, 10.5, 10]);
  assert.deepEqual(recs.map((r) => r.pa), [95800, 95700, 95600, 95500], 'linear in time between the previous pressure packet and now');
  assert.deepEqual(recs.map((r) => r.ang), [197, 198, 199, 200]);
  assert.ok(recs.every((r) => r.alt !== null && r.altAgl !== null && r.sondeId === 1 && r.raw.startsWith('[#MET')));
  assert.equal(recs[0].seq, null); assert.equal(recs[3].seq, 2);
  // previous pressure too old (> 22 s) → INF without pressure
  const late = tb.records(msg('[#MET:id=1,seq=3,md=2,pa=95000,te=9,hu=55,te1=9.5,hu1=54]', 130000));
  assert.equal(late[0].pa, null); assert.equal(late[1].pa, 95000);
});

test('events: cutdown (manual/auto), wireTest, wireHeated, announce, timeout, packet', () => {
  const tb = new TelemetryBuilder();
  tb.startSession({ groundAlt: 432, groundPa: 96240 });
  tb.records(msg('[#DAT:id=7,seq=1,md=2,pa=80000,te=0,hu=40]', 1000));
  const c = tb.event(msg('[#TXT:id=7:C(A1234T56)]', 2000));
  assert.equal(c.type, 'cutdown'); assert.equal(c.data.by, 'auto'); assert.deepEqual(c.data.letters, { A: 1234, T: 56 }); assert.ok(c.data.altAgl > 1000);
  tb.lastManualCutT = 1500;
  assert.equal(tb.event(msg('[#TXT:id=7:C(A1)]', 2000)).data.by, 'manual');
  const w = tb.event(msg('[#TXT:id=7:R(S57B411C0L1)]', 3000));
  assert.equal(w.type, 'wireTest'); assert.equal(w.data.primaryOk, true); assert.equal(w.data.secondaryOk, false); assert.equal(w.data.ledOk, true); assert.equal(w.data.battOk, true); assert.equal(w.data.primaryA, 0.57);
  assert.equal(tb.event(msg('[#TXT:id=7:w(1)]', 3000)).type, 'wireHeated');
  assert.equal(tb.event(msg('[#TXT:id=7:hello]', 3000)).type, 'text');
  const a = tb.event(msg('[#ANN:id=7,sid=2]', 3000)); assert.equal(a.type, 'announce'); assert.equal(a.data.id, 7); assert.equal(a.data.sid, 2);
  assert.equal(tb.event(msg('[#TIM:]', 3000)).type, 'timeout');
  assert.equal(tb.event(msg('[#CMD:x=1]', 3000)), null);
  const pk = tb.packet(msg('[#PK:rs=-90,snr=5,rec=1,hderr=0,bderr=0,crc=S]', 4000));
  assert.deepEqual(pk, { rssi: 55 / 90, rs: -90, snr: 5, rec: 1, t: 4000 });
  assert.equal(tb.packet(msg('[#PK:crc=S]', 4000)), null);
  assert.equal(decodeWireTest({ S: 10, L: 0 }).primaryOk, false); assert.equal(decodeWireTest({ S: 10 }).ledOk, null); assert.equal(decodeWireTest({}).secondaryConfigured, false);
});

test('partial positions (latm/latd) relative to the last full fix', () => {
  const tb = new TelemetryBuilder();
  tb.records(msg('[#DAT:id=1,seq=1,md=1,lat=47.5,lon=8.25,pa=96000]', 1000));
  const [m] = tb.records(msg('[#DAT:id=1,seq=2,md=1,latm=300000,lonm=150000,pa=96000]', 2000));
  assert.ok(Math.abs(m.lat - 47.5) < 1e-9 && Math.abs(m.lon - 8.25) < 1e-9);
  const [d] = tb.records(msg('[#DAT:id=1,seq=3,md=1,latd=5000,lond=5000,pa=96000]', 3000));
  assert.ok(Math.abs(d.lat - (47 + 30.5 / 60)) < 1e-9, `latd ${d.lat}`); assert.ok(Math.abs(d.lon - (8 + 15.5 / 60)) < 1e-9);
});
