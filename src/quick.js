// Schnellstart ("Sonde sofort hier starten") – the pure decisions, no DOM and no state (node tests run them):
// cutdown stepper, "hier" = start position from the best available source, and the single readiness verdict
// that the status box of step 3 shows. The page itself is ui/quick.js (+ quick-live.js); docs/KONZEPT-Schnellstart.md.

import { distanceM } from './util/format.js';

export const CUT_MIN = 500, CUT_MAX = 12000, CUT_STEP = 500;      // m AGL (owner decision: 500 m steps)

export function clampCut(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 3000;
  return Math.min(CUT_MAX, Math.max(CUT_MIN, n));
}
/** dir = +1 / −1 → one step up / down, clamped to the allowed range. */
export function stepCut(v, dir) { return clampCut(clampCut(v) + dir * CUT_STEP); }

/** Sonde number as printed on the board: five digits, «00123». */
export const sondeNr = (id) => String(id ?? '').padStart(5, '0');

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const hasPos = (o) => !!o && finite(o.lat) && finite(o.lon) && !(o.lat === 0 && o.lon === 0);

/**
 * Where "hier" is. Order: GPS of the receiver (RR4) → GPS of the device (laptop / pad) → the app's default start.
 * Altitude (m AMSL): receiver altitude → the sonde's own GNSS altitude (it lies next to the receiver) → default start.
 * Returns {source:'rx'|'device'|'default', lat, lon, alt}.
 */
export function hereFrom({ receiver, device, sondeRec, fallback }) {
  if (hasPos(receiver)) {
    const sondeAlt = sondeRec && hasPos(sondeRec) && finite(sondeRec.gpsAlt) ? sondeRec.gpsAlt : null;
    const alt = finite(receiver.alt) ? receiver.alt : sondeAlt ?? fallback.alt;
    return { source: 'rx', lat: receiver.lat, lon: receiver.lon, alt: Math.round(alt) };
  }
  if (hasPos(device)) return { source: 'device', lat: device.lat, lon: device.lon, alt: Math.round(fallback.alt) };
  return { source: 'default', lat: fallback.lat, lon: fallback.lon, alt: Math.round(fallback.alt) };
}

/** True when the start moved enough (or changed its source) to make a new airspace check worthwhile. */
export function startMoved(a, b, sourceA, sourceB, minM = 100) {
  if (!a || !b) return true;
  if (sourceA !== sourceB) return true;
  return distanceM(a.lat, a.lon, b.lat, b.lon) > minM || Math.abs((a.alt ?? 0) - (b.alt ?? 0)) > 25;
}

/**
 * The ONE status of step 3. `items` = checks.js computeChecks() (all but «observers» count – the relay to s2stueve
 * never keeps a sonde on the ground); md = sonde mode (1 = ready);
 * working = 'check'|'program'|'wire' while the start sequence runs; error = {kind, msg} when a step failed.
 * level: 'wait' (amber – it resolves by itself, keep holding), 'fail' (red – a person has to act), 'go' (green).
 * code names the message (i18n quick.st.<code>.t / .s): waits check · program · wire · gps · rxgps · sensors · radio · ready,
 * fails noRx · wireBad · battery · settings · programFailed · wireError, go.
 */
export function startVerdict(items, { md = null, working = null, error = null } = {}) {
  if (error) return { level: 'fail', code: error.kind, msg: error.msg || '' };
  if (working) return { level: 'wait', code: working };
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  const lvl = (id) => (by[id] ? by[id].level : 'warn');
  if (lvl('radio') === 'bad') return { level: 'fail', code: 'noRx' };
  if (lvl('wire') === 'bad') return { level: 'fail', code: 'wireBad' };
  if (lvl('battery') === 'bad' || (by.battery && by.battery.low)) return { level: 'fail', code: 'battery' };
  if (lvl('settings') !== 'ok') return { level: 'fail', code: 'settings' };
  if (lvl('wire') !== 'ok') return { level: 'wait', code: 'wire' };
  if (lvl('sondeGps') !== 'ok') return { level: 'wait', code: 'gps' };
  if (lvl('rxGps') !== 'ok') return { level: 'wait', code: 'rxgps' };
  if (lvl('sensors') !== 'ok' || lvl('battery') !== 'ok') return { level: 'wait', code: 'sensors' };
  if (lvl('radio') !== 'ok') return { level: 'wait', code: 'radio' };
  if (md !== 1) return { level: 'wait', code: 'ready' };
  return { level: 'go', code: 'go' };
}
