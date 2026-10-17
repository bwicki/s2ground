// node --test: planning stub – lift model, trajectory, airspace helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liftForRiseRate, burstAltitude, fallbackProfile, profileAt, predict, planAt, pointInPolygon, airspaceConflicts, suggestCutdownAgl, fromOpenAip, openAipLimitM, openAipLimitText, bboxOf } from '../src/planning.js';

const sample = JSON.parse(readFileSync(new URL('../src/data/airspaces.json', import.meta.url)));
const airspaces = fromOpenAip(sample.items, 432, ['P', 'R', 'D', 'CTR', 'TMA']);
const start = { lat: 47.4433, lon: 8.5617, alt: 432 };

test('lift for 2.5 m/s with a 9 g balloon and 14 g payload ≈ 39 g gross (design board)', () => {
  const l = liftForRiseRate(2.5, 9, 14);
  assert.ok(l.grossLiftG > 34 && l.grossLiftG < 44, `gross ${l.grossLiftG}`);
  assert.ok(l.gasL > 40 && l.gasL < 56, `gas ${l.gasL}`);
  assert.ok(burstAltitude(9, l.gasL) > 7000 && burstAltitude(9, l.gasL) < 13000);
});

test('profile interpolation', () => {
  const lv = fallbackProfile(240, 6);
  const w = profileAt(lv, 1250);
  assert.ok(w.spd > 6 && w.spd < 12 && w.dir > 240 && w.dir < 260);
  assert.equal(profileAt(lv, -10).altM, 0);
});

test('trajectory drifts downwind and lands after the cutdown', () => {
  const r = predict({ start, launchMs: 0, riseRate: 2.5, descentRate: 5, cutAltAgl: 1600, levels: fallbackProfile(240, 6) });
  assert.ok(Math.abs(r.maxAlt - 2032) < 1);
  assert.ok(r.ascentS >= 630 && r.ascentS <= 650, `ascent ${r.ascentS}`);
  assert.ok(r.totalS > r.ascentS + 200);
  assert.ok(r.bearing > 40 && r.bearing < 80, `bearing ${r.bearing}`);     // wind from ~240° → NE
  assert.ok(r.distanceM > 3000 && r.distanceM < 12000, `dist ${r.distanceM}`);
  assert.equal(r.points[0].phase, 'ascent'); assert.equal(r.points[r.points.length - 1].phase, 'descent');
  const mid = planAt(r, 300);
  assert.ok(Math.abs(mid.alt - (432 + 750)) < 1);
});

test('no cutdown → climbs to the burst altitude', () => {
  const r = predict({ start, riseRate: 2.5, descentRate: 5, cutAltAgl: null, burstAltAmsl: 9800, levels: fallbackProfile(240, 6) });
  assert.equal(r.cutdown.kind, 'burst'); assert.ok(Math.abs(r.maxAlt - 9800) < 1);
});

test('airspace conflicts and suggestion', () => {
  assert.equal(pointInPolygon(47.47, 8.65, airspaces[0].polygon), true);
  assert.equal(pointInPolygon(47.40, 8.50, airspaces[0].polygon), false);
  const levels = fallbackProfile(240, 6);
  const hi = predict({ start, riseRate: 2.5, descentRate: 5, cutAltAgl: 3000, levels });
  const c = airspaceConflicts(hi.points, airspaces);
  assert.ok(c.some((x) => x.airspace.id === 'LS-R12'), 'LS-R12 sample must be crossed at 3000 m AGL');
  const agl = suggestCutdownAgl(c, start.alt);
  assert.equal(agl, 1500);                                    // 2100 m AMSL (6890 ft) − 100 − 432 → floor 100 → 1500
  const lo = predict({ start, riseRate: 2.5, descentRate: 5, cutAltAgl: agl, levels });
  assert.equal(airspaceConflicts(lo.points, airspaces).some((x) => x.airspace.id === 'LS-R12'), false);
  assert.equal(suggestCutdownAgl([], 432), null);
});

test('openAIP adapter: limits, categories, MultiPolygon, bbox', () => {
  assert.equal(Math.round(openAipLimitM({ value: 100, unit: 6, referenceDatum: 2 }, 432)), 3048);   // FL100
  assert.equal(Math.round(openAipLimitM({ value: 1000, unit: 1, referenceDatum: 0 }, 432)), 737);   // 1000 ft GND + 432
  assert.equal(openAipLimitM({ value: 0, unit: 1, referenceDatum: 0 }, 432), 432);
  assert.equal(openAipLimitText({ value: 0, unit: 1, referenceDatum: 0 }), 'GND');
  assert.equal(openAipLimitText({ value: 195, unit: 6, referenceDatum: 2 }), 'FL 195');
  const ring = [[8.5, 47.4], [8.6, 47.4], [8.6, 47.5], [8.5, 47.5], [8.5, 47.4]];
  const items = [
    { _id: 'a', name: 'LS-D 1', type: 2, lowerLimit: { value: 0, unit: 1, referenceDatum: 0 }, upperLimit: { value: 5000, unit: 1, referenceDatum: 1 }, geometry: { type: 'MultiPolygon', coordinates: [[ring], [ring]] } },
    { _id: 'b', name: 'Glider', type: 21, lowerLimit: { value: 0, unit: 1, referenceDatum: 0 }, upperLimit: { value: 50, unit: 6, referenceDatum: 2 }, geometry: { type: 'Polygon', coordinates: [ring] } },
    { _id: 'c', name: 'no geom', type: 1 },
  ];
  const out = fromOpenAip(items, 400, ['D', 'R']);
  assert.equal(out.length, 2);                                 // MultiPolygon → 2 entries, glider filtered, no geometry skipped
  assert.equal(out[0].id, 'a#1'); assert.equal(out[0].type, 'D'); assert.equal(out[0].lowerM, 400);
  assert.deepEqual(out[0].polygon[0], [47.4, 8.5]);            // [lat, lon]
  assert.equal(fromOpenAip(items, 400, ['GLD']).length, 1);
  const b = bboxOf([{ lat: 47.4, lon: 8.5 }, { lat: 47.6, lon: 8.9 }], 0.1);
  assert.deepEqual(b.map((v) => +v.toFixed(2)), [8.4, 47.3, 9.0, 47.7]);
});
