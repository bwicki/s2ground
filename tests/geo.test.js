// node --test: place names «CC-Ort» (src/geo.js) – label building from Nominatim addresses, candidate
// list without duplicates, search/reverse URLs and the per-position memo. fetch is injected; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeLabel, placeRegion, candidatesFrom, searchPlaces, reversePlace, placeFor } from '../src/geo.js';

const baden = (cc, state, extra = {}) => ({ lat: '47.47', lon: '8.30', display_name: 'Baden, Aargau, Schweiz', addresstype: 'town', address: { town: 'Baden', state, country_code: cc, ...extra } });

test('placeLabel: country code + most specific locality; fallback to the first display_name part', () => {
  assert.equal(placeLabel(baden('ch', 'Aargau')), 'CH-Baden');
  assert.equal(placeLabel({ display_name: 'Katzenrüti, Rümlang, Zürich, Schweiz', address: { hamlet: 'Katzenrüti', village: 'Rümlang', country_code: 'ch' } }), 'CH-Rümlang');   // village beats hamlet
  assert.equal(placeLabel({ display_name: 'Irgendwo, Land', address: { country_code: 'de' } }), 'DE-Irgendwo');
  assert.equal(placeLabel({ display_name: 'Nirgendwo' }), 'Nirgendwo');
  assert.equal(placeLabel(null), '');
  assert.equal(placeRegion(baden('ch', 'Aargau', { county: 'Bezirk Baden' })), 'Aargau · Bezirk Baden');
});

test('candidatesFrom: every country with that name stays, exact duplicates go', () => {
  const items = [baden('ch', 'Aargau'), baden('at', 'Niederösterreich'), baden('ch', 'Aargau'), { ...baden('de', 'Baden-Württemberg'), address: { city: 'Baden-Baden', state: 'Baden-Württemberg', country_code: 'de' } }];
  const c = candidatesFrom(items);
  assert.deepEqual(c.map((x) => x.label), ['CH-Baden', 'AT-Baden', 'DE-Baden-Baden']);
  assert.equal(c[0].lat, 47.47); assert.equal(c[0].type, 'town');
});

test('searchPlaces asks Nominatim for all candidates with address details; reversePlace returns CC-Ort', async () => {
  const seen = [];
  const f = async (url) => { seen.push(String(url)); return new Response(JSON.stringify(seen.length === 1 ? [baden('ch', 'Aargau'), baden('at', 'Niederösterreich')] : baden('ch', 'Aargau')), { status: 200 }); };
  const c = await searchPlaces('Baden', f);
  assert.equal(c.length, 2);
  const u = new URL(seen[0]);
  assert.equal(u.pathname, '/search'); assert.equal(u.searchParams.get('q'), 'Baden'); assert.equal(u.searchParams.get('addressdetails'), '1'); assert.equal(u.searchParams.get('limit'), '10');
  assert.equal(await reversePlace(47.47, 8.30, f), 'CH-Baden');
  assert.equal(new URL(seen[1]).pathname, '/reverse');
  const bad = async () => new Response('x', { status: 503 });
  await assert.rejects(() => searchPlaces('Baden', bad), /geocode 503/);
});

test('placeFor memoises per ~100 m and swallows errors', async () => {
  let calls = 0;
  const f = async () => { calls++; return new Response(JSON.stringify(baden('ch', 'Aargau')), { status: 200 }); };
  assert.equal(await placeFor(47.4700, 8.3000, f), 'CH-Baden');
  assert.equal(await placeFor(47.4702, 8.3003, f), 'CH-Baden');      // same cell → no second request
  assert.equal(calls, 1);
  assert.equal(await placeFor(47.9, 8.9, async () => { throw new Error('offline'); }), null);
});
