// node --test: SimGroundLink state transitions and telemetry records (no timers: advance()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimGroundLink } from '../web/src/sim/sim-link.js';
import { csvRow } from '../web/src/files.js';

async function makeLink(opts = {}) {
  const link = new SimGroundLink({ speed: 1000, gpsFixS: 5, launchDelayS: 2, cutAltAgl: 300, seed: 7, ...opts });
  const recs = [], events = [];
  link.addEventListener('telemetry', (e) => recs.push(e.detail));
  link.addEventListener('event', (e) => events.push(e.detail));
  await link.connect();
  link._stop();                     // drive the clock manually
  return { link, recs, events };
}

test('full scripted flight: gps wait → ready → launch → cutdown → falling → landed', async () => {
  const { link, recs, events } = await makeLink();
  assert.equal(link.state.port, 'open');
  assert.equal(link.state.sonde.md, 0);
  link.advance(5);
  assert.equal(link.state.sonde.md, 1, 'ready after the GPS fix');
  assert.equal(recs[0].lat, null, 'no position before the fix');
  link.startSession({ groundAlt: 432, groundPa: 96240 });
  link.release(); link.advance(3);
  assert.equal(link.state.sonde.md, 2, 'rising');
  for (let i = 0; i < 400 && !events.some((e) => e.type === 'cutdown'); i++) link.advance(1);
  assert.ok(events.some((e) => e.type === 'cutdown'), 'cutdown event emitted');
  const cut = events.find((e) => e.type === 'cutdown');
  assert.ok(cut.data.altAgl >= 300 && cut.data.altAgl < 310, `cut at ${cut.data.altAgl}`);
  assert.equal(cut.data.by, 'auto');
  assert.equal(link.state.sonde.md, 7, 'cutting');
  link.advance(3);
  assert.equal(link.state.sonde.md, 3, 'falling');
  link.advance(300);
  assert.equal(link.state.sonde.md, 4, 'landed');
  const last = recs[recs.length - 1];
  assert.ok(last.altAgl < 0 && last.altAgl > -25);
  assert.ok(last.lat > 47.44 && last.lon > 8.56, 'drifted north-east');
  assert.ok(recs.length > 150);
  // packets are TelemetryRecords usable by the CSV writer
  const row = csvRow(recs[50], 432);
  assert.ok(row && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}, \d+, -?\d+, \d+, /.test(row), row);
  assert.ok(recs.every((r) => r.src === 'SIM' && r.pa > 60000 && r.raw.startsWith('[#DAT:')));
});

test('manual cutdown and wire test', async () => {
  const { link, events } = await makeLink({ cutAltAgl: 5000 });
  link.advance(5); link.release(); link.advance(30);
  const wt = await link.ledAndWireTest();
  assert.equal(wt.primaryOk, true);
  await link.cutdown();
  link.advance(2);
  const cut = events.find((e) => e.type === 'cutdown');
  assert.ok(cut && cut.data.by === 'manual');
  assert.equal(link.state.sonde.md, 7);
});

test('deterministic with the same seed, packet loss every 97th seq', async () => {
  const a = await makeLink({ seed: 3 }), b = await makeLink({ seed: 3 });
  a.link.advance(5); a.link.release(); a.link.advance(120);
  b.link.advance(5); b.link.release(); b.link.advance(120);
  assert.deepEqual(a.recs.map((r) => [r.pa, r.te]), b.recs.map((r) => [r.pa, r.te]));
  assert.ok(!a.recs.some((r) => r.seq === 97));
});

test('setCutdownAltitude reads back the value', async () => {
  const { link } = await makeLink();
  assert.equal(await link.setCutdownAltitude(1600, 96240), 1600);
  assert.equal(link.state.sonde.cutAltAgl, 1600);
});
