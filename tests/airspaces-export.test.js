// node --test: the nightly export build (tools/build-airspaces.mjs) and the regional file consumer
// (src/airspaces-static.js) – bbox maths, slimming/rounding, dedupe, coverage, filtering, session load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion, slimFeature, geometryBbox, bboxIntersects, DEFAULT_REGION } from '../tools/build-airspaces.mjs';
import { parseRegionFile, filterByBbox, coversBbox, airspacesFromFile, loadRegionFile } from '../src/airspaces-static.js';

const poly = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const feat = (id, name, type, geom, extra = {}) => ({ type: 'Feature', geometry: geom, properties: { _id: id, name, type, icaoClass: 8, country: 'CH', lowerLimit: { value: 0, unit: 1, referenceDatum: 0 }, upperLimit: { value: 100, unit: 6, referenceDatum: 2 }, frequencies: [], hoursOfOperation: {}, ...extra } });

test('geometryBbox / bboxIntersects', () => {
  assert.deepEqual(geometryBbox(poly(8.1, 47.1, 8.4, 47.3)), [8.1, 47.1, 8.4, 47.3]);
  assert.deepEqual(geometryBbox({ type: 'MultiPolygon', coordinates: [poly(8, 47, 8.2, 47.2).coordinates, poly(9, 46, 9.5, 46.5).coordinates] }), [8, 46, 9.5, 47.2]);
  assert.equal(geometryBbox({ type: 'Point', coordinates: [8, 47] }), null);
  assert.ok(bboxIntersects([8, 47, 9, 48], [8.9, 47.9, 10, 49]));
  assert.ok(!bboxIntersects([8, 47, 9, 48], [9.1, 47, 10, 48]));
});

test('slimFeature keeps only what the app needs, rounds to 4 decimals, drops features outside the region', () => {
  const f = feat('a1', 'LS-R12', 1, poly(8.123456, 47.123456, 8.4, 47.3));
  const it = slimFeature(f, DEFAULT_REGION);
  assert.deepEqual(Object.keys(it).sort(), ['_id', 'country', 'geometry', 'icaoClass', 'lowerLimit', 'name', 'type', 'upperLimit']);
  assert.deepEqual(it.geometry.coordinates[0][0], [8.1235, 47.1235]);
  assert.equal(slimFeature(feat('b', 'far', 1, poly(20, 60, 21, 61)), DEFAULT_REGION), null);
  // flat API items (no properties) are accepted too
  assert.equal(slimFeature({ _id: 'c', name: 'X', type: 4, geometry: poly(8, 47, 8.1, 47.1) }, DEFAULT_REGION).name, 'X');
});

test('buildRegion merges countries, dedupes by _id, sorts by name and reports meta', () => {
  const ch = { type: 'FeatureCollection', features: [feat('1', 'LSZH CTR', 4, poly(8.4, 47.3, 8.7, 47.6)), feat('2', 'LS-R12', 1, poly(8, 47, 8.2, 47.2))] };
  const de = { type: 'FeatureCollection', features: [feat('1', 'LSZH CTR', 4, poly(8.4, 47.3, 8.7, 47.6)), feat('3', 'EDNY CTR', 4, poly(9.4, 47.6, 9.7, 47.8)), feat('4', 'far north', 4, poly(10, 53, 11, 54))] };
  const out = buildRegion([ch, de], DEFAULT_REGION, ['ch', 'de']);
  assert.equal(out.count, 3);
  assert.deepEqual(out.items.map((i) => i.name), ['EDNY CTR', 'LS-R12', 'LSZH CTR']);
  assert.deepEqual(out.countries, ['ch', 'de']); assert.deepEqual(out.region, DEFAULT_REGION);
  assert.ok(Date.parse(out.generated) > 0); assert.match(out.source, /s3\.openaip\.net/);
});

test('consumer: parse → cover check → bbox filter → Worker-shaped answer; loaded once per session', async () => {
  const file = buildRegion([{ features: [feat('1', 'LSZH CTR', 4, poly(8.4, 47.3, 8.7, 47.6)), feat('2', 'LS-R12', 1, poly(8, 47, 8.2, 47.2))] }], DEFAULT_REGION, ['ch']);
  const parsed = parseRegionFile(file);
  assert.equal(parsed.meta.count, 2); assert.ok(parsed.items[0]._bbox);
  assert.ok(coversBbox(parsed.meta.region, [8, 47, 9, 48])); assert.ok(!coversBbox(parsed.meta.region, [4, 47, 9, 48]));
  assert.deepEqual(filterByBbox(parsed.items, [8.5, 47.4, 8.6, 47.5]).map((i) => i.name), ['LSZH CTR']);
  let calls = 0;
  const fetchFn = async () => { calls++; return new Response(JSON.stringify(file), { status: 200 }); };
  await loadRegionFile('https://x/airspaces-region.json', fetchFn, { force: true });
  const r = await airspacesFromFile([8.5, 47.4, 8.6, 47.5], 'https://x/airspaces-region.json', fetchFn);
  assert.equal(calls, 1); assert.equal(r.via, 'export'); assert.equal(r.items.length, 1); assert.equal(r.items[0]._bbox, undefined); assert.equal(r.generated, file.generated);
  assert.equal(await airspacesFromFile([4, 47, 9, 48], 'https://x/airspaces-region.json', fetchFn), null);   // outside the region → live routes
  assert.equal(calls, 1);
  const bad = async () => new Response('nope', { status: 404 });
  await assert.rejects(() => loadRegionFile('https://x/missing.json', bad, { force: true }), /E_AIRSPACE_FILE \(404\)/);
});
