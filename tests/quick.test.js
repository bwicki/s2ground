// node --test: Schnellstart logic (cutdown stepper, "hier", readiness verdict) and its texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { state, resetAscent } from '../src/state.js';
import { CUT_MIN, CUT_MAX, CUT_STEP, clampCut, stepCut, sondeNr, hereFrom, startMoved, startVerdict } from '../src/quick.js';

const root = new URL('../', import.meta.url).pathname;
const de = JSON.parse(readFileSync(join(root, 'i18n/de.json'), 'utf8'));
const en = JSON.parse(readFileSync(join(root, 'i18n/en.json'), 'utf8'));

test('cutdown stepper: 500 m steps between 500 and 12\'000 m', () => {
  assert.equal(CUT_STEP, 500); assert.equal(CUT_MIN, 500); assert.equal(CUT_MAX, 12000);
  assert.equal(stepCut(3000, +1), 3500);
  assert.equal(stepCut(3000, -1), 2500);
  assert.equal(stepCut(500, -1), 500);                   // lower limit
  assert.equal(stepCut(12000, +1), 12000);               // upper limit
  assert.equal(stepCut(1500, -1), 1000);
  assert.equal(clampCut(100), 500); assert.equal(clampCut(99999), 12000);
  assert.equal(clampCut('x'), 3000); assert.equal(clampCut(undefined), 3000);
  // a value that is not on the 500 m grid (e.g. 1'900 from the full plan) steps by exactly 500 and never leaves the range
  assert.equal(stepCut(1900, +1), 2400); assert.equal(stepCut(1900, -1), 1400);
});

test('sondeNr pads to five digits like the board', () => {
  assert.equal(sondeNr(123), '00123'); assert.equal(sondeNr('7'), '00007'); assert.equal(sondeNr(12345), '12345');
  assert.equal(sondeNr(null), '00000');
});

const fb = { lat: 47.38, lon: 8.54, alt: 410 };
test('hier: receiver GPS first, then device GPS, then the default start', () => {
  const rx = hereFrom({ receiver: { lat: 47.1, lon: 8.1, alt: 523.4 }, device: { lat: 46, lon: 7 }, fallback: fb });
  assert.deepEqual(rx, { source: 'rx', lat: 47.1, lon: 8.1, alt: 523 });
  const dev = hereFrom({ receiver: { lat: 0, lon: 0 }, device: { lat: 46.5, lon: 7.5 }, fallback: fb });
  assert.deepEqual(dev, { source: 'device', lat: 46.5, lon: 7.5, alt: 410 });
  const def = hereFrom({ receiver: null, device: null, fallback: fb });
  assert.deepEqual(def, { source: 'default', lat: 47.38, lon: 8.54, alt: 410 });
  // receiver without altitude: take the sonde's own GNSS altitude (it lies next to the receiver)
  const noAlt = hereFrom({ receiver: { lat: 47.1, lon: 8.1 }, sondeRec: { lat: 47.1, lon: 8.1, gpsAlt: 611.6 }, fallback: fb });
  assert.equal(noAlt.source, 'rx'); assert.equal(noAlt.alt, 612);
  const noAlt2 = hereFrom({ receiver: { lat: 47.1, lon: 8.1 }, fallback: fb });
  assert.equal(noAlt2.alt, 410);
});

test('startMoved: new airspace check only when start moved ≥100 m, changed ≥25 m in altitude or changed source', () => {
  const a = { lat: 47.0, lon: 8.0, alt: 500 };
  assert.equal(startMoved(a, { ...a }, 'rx', 'rx'), false);
  assert.equal(startMoved(a, { lat: 47.0003, lon: 8.0, alt: 500 }, 'rx', 'rx'), false);   // ≈ 33 m
  assert.equal(startMoved(a, { lat: 47.002, lon: 8.0, alt: 500 }, 'rx', 'rx'), true);     // ≈ 222 m
  assert.equal(startMoved(a, { ...a, alt: 540 }, 'rx', 'rx'), true);
  assert.equal(startMoved(a, { ...a }, 'default', 'rx'), true);
  assert.equal(startMoved(null, a, 'rx', 'rx'), true);
});

const ok = (id, extra = {}) => ({ id, level: 'ok', ...extra });
const allOk = () => ['radio', 'sondeGps', 'rxGps', 'battery', 'sensors', 'wire', 'settings', 'observers'].map((id) => ok(id));
const withLevel = (id, level, extra = {}) => allOk().map((i) => (i.id === id ? { ...i, level, ...extra } : i));

test('startVerdict: everything green and sonde mode 1 → go', () => {
  assert.deepEqual(startVerdict(allOk(), { md: 1 }), { level: 'go', code: 'go' });
});

test('startVerdict: observers never keep the sonde on the ground', () => {
  assert.equal(startVerdict(withLevel('observers', 'bad'), { md: 1 }).level, 'go');
  assert.equal(startVerdict(withLevel('observers', 'warn'), { md: 1 }).level, 'go');
});

test('startVerdict: waits (amber) resolve by themselves', () => {
  assert.deepEqual(startVerdict(allOk(), { md: 2 }), { level: 'wait', code: 'ready' });
  assert.deepEqual(startVerdict(allOk(), { md: null }), { level: 'wait', code: 'ready' });
  assert.deepEqual(startVerdict(withLevel('sondeGps', 'warn'), { md: 1 }), { level: 'wait', code: 'gps' });
  assert.deepEqual(startVerdict(withLevel('rxGps', 'warn'), { md: 1 }), { level: 'wait', code: 'rxgps' });
  assert.deepEqual(startVerdict(withLevel('sensors', 'warn'), { md: 1 }), { level: 'wait', code: 'sensors' });
  assert.deepEqual(startVerdict(withLevel('radio', 'warn'), { md: 1 }), { level: 'wait', code: 'radio' });
  assert.deepEqual(startVerdict(withLevel('wire', 'warn'), { md: 1 }), { level: 'wait', code: 'wire' });
  assert.deepEqual(startVerdict(allOk(), { md: 1, working: 'program' }), { level: 'wait', code: 'program' });
});

test('startVerdict: fails (red) need a person', () => {
  assert.deepEqual(startVerdict(withLevel('radio', 'bad'), { md: 1 }), { level: 'fail', code: 'noRx' });
  assert.deepEqual(startVerdict(withLevel('wire', 'bad'), { md: 1 }), { level: 'fail', code: 'wireBad' });
  assert.deepEqual(startVerdict(withLevel('battery', 'bad'), { md: 1 }), { level: 'fail', code: 'battery' });
  assert.deepEqual(startVerdict(withLevel('battery', 'warn', { low: true }), { md: 1 }), { level: 'fail', code: 'battery' });
  assert.deepEqual(startVerdict(withLevel('settings', 'warn'), { md: 1 }), { level: 'fail', code: 'settings' });
  assert.deepEqual(startVerdict(withLevel('settings', 'bad'), { md: 1 }), { level: 'fail', code: 'settings' });
  assert.deepEqual(startVerdict(allOk(), { md: 1, error: { kind: 'programFailed', msg: 'E_TIMEOUT' } }), { level: 'fail', code: 'programFailed', msg: 'E_TIMEOUT' });
});

test('startVerdict: an error beats everything, a failure beats a wait, missing checks count as not ok', () => {
  assert.equal(startVerdict(withLevel('radio', 'bad'), { md: 1, working: 'wire', error: { kind: 'wireError' } }).code, 'wireError');
  assert.equal(startVerdict(withLevel('radio', 'bad'), { md: 1, working: 'wire' }).code, 'wire');   // the running step is shown first
  const both = allOk().map((i) => (i.id === 'sondeGps' ? { ...i, level: 'warn' } : i.id === 'battery' ? { ...i, level: 'bad' } : i));
  assert.equal(startVerdict(both, { md: 1 }).code, 'battery');
  assert.notEqual(startVerdict([], { md: 1 }).level, 'go');
});

test('every status code has its texts in de and en', () => {
  const codes = ['check', 'program', 'wire', 'gps', 'rxgps', 'sensors', 'radio', 'ready', 'noRx', 'wireBad', 'battery', 'settings', 'programFailed', 'wireError', 'go'];
  for (const c of codes) for (const k of [`quick.st.${c}.t`, `quick.st.${c}.s`]) {
    assert.ok(k in de, `de: ${k}`); assert.ok(k in en, `en: ${k}`);
  }
});

test('every quick.* / log.quickstart key used by the Schnellstart pages exists in de and en', () => {
  const used = new Set();
  for (const f of ['src/ui/quick.js', 'src/ui/quick-live.js', 'src/ui/login.js', 'src/ui/header.js', 'src/app.js']) {
    const src = readFileSync(join(root, f), 'utf8');
    for (const m of src.matchAll(/'(quick\.[a-zA-Z0-9_.]+|log\.quickstart)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/\btx?\(\s*'([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size > 40, 'scan finds the keys');
  assert.deepEqual([...used].filter((k) => !(k in de)), []);
  assert.deepEqual([...used].filter((k) => !(k in en)), []);
});

test('user-visible quick texts keep the Swiss spelling (no «ß») and the agreed terms', () => {
  for (const [k, v] of Object.entries(de)) if (k.startsWith('quick.')) assert.ok(!v.includes('ß'), k);
  const all = Object.entries(de).filter(([k]) => k.startsWith('quick.')).map(([, v]) => v).join(' ');
  assert.match(all, /Cutdown/); assert.match(all, /AMSL/); assert.match(all, /AGL/);
  assert.doesNotMatch(all, /Abschnitt|Kappung|Abtrennung/);
});

test('docs: observer codes are 6 characters (owner decision), not 8', () => {
  const doc = readFileSync(join(root, 'docs/INTERFACE.md'), 'utf8');
  assert.doesNotMatch(doc, /8 characters/i);
});

test('resetAscent (archiving) works while app.js has the relay counters as getter-only properties', () => {
  Object.defineProperty(state.relay, 'sent', { get: () => 5, configurable: true });
  Object.defineProperty(state.relay, 'errors', { get: () => 1, configurable: true });
  assert.doesNotThrow(() => resetAscent());
  assert.equal(state.relay.sent, 0); assert.equal(state.relay.errors, 0);
  assert.equal(state.quick, null);
});
