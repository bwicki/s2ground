// node --test: the browser-side openAIP fallback (src/openaip-direct.js) – URL shape, paging, slim items,
// bbox quantisation and the Worker-compatible error vocabulary. fetch is injected; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAirspacesDirect, quantize, OPENAIP_UPSTREAM } from '../src/openaip-direct.js';

const page = (items, totalPages) => ({ items, totalPages });
const fake = (script, seen = []) => async (url) => {
  const step = script[Math.min(seen.length, script.length - 1)]; seen.push(String(url));
  return new Response(typeof step.body === 'string' ? step.body : JSON.stringify(step.body), { status: step.status });
};

test('bbox is quantised to 0.2° like the Worker so one cell = one request', () => {
  assert.deepEqual(quantize([8.47, 47.31, 8.63, 47.49]), [8.4, 47.2, 8.8, 47.6]);
  assert.deepEqual(quantize([8.4, 47.4, 8.6, 47.6]), [8.4, 47.4, 8.6, 47.6]);
});

test('apiKey in the query, limit + page, follows totalPages, returns slim items with via=browser', async () => {
  const seen = [];
  const f = fake([{ status: 200, body: page([{ _id: '1', name: 'LS-R12', type: 1, icaoClass: 8, lowerLimit: { value: 0, unit: 1, referenceDatum: 0 }, upperLimit: {}, geometry: {}, country: 'CH', extra: 'x' }], 2) },
                  { status: 200, body: page([{ _id: '2', name: 'LSZH CTR', type: 4 }], 2) }], seen);
  const r = await fetchAirspacesDirect([8.47, 47.31, 8.63, 47.49], 'k3y', f);
  assert.equal(seen.length, 2);
  const u = new URL(seen[0]);
  assert.equal(u.origin + u.pathname, OPENAIP_UPSTREAM);
  assert.equal(u.searchParams.get('apiKey'), 'k3y');
  assert.equal(u.searchParams.get('bbox'), '8.4,47.2,8.8,47.6');
  assert.equal(u.searchParams.get('page'), '1'); assert.equal(new URL(seen[1]).searchParams.get('page'), '2');
  assert.equal(r.via, 'browser'); assert.equal(r.items.length, 2);
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['_id', 'geometry', 'icaoClass', 'lowerLimit', 'name', 'type', 'upperLimit']);   // slim – no country/extra
});

test('errors use the Worker vocabulary: JSON 401/403 → key rejected (409), HTML 403 / network → unreachable (502)', async () => {
  await assert.rejects(() => fetchAirspacesDirect([8.4, 47.3, 8.6, 47.5], 'k', fake([{ status: 401, body: { message: 'Unauthorized' } }])), (e) => e.status === 409 && /^E_OPENAIP_KEY_REJECTED \(browser 401/.test(e.message));
  await assert.rejects(() => fetchAirspacesDirect([8.4, 47.3, 8.6, 47.5], 'k', fake([{ status: 403, body: '<!doctype html><title>403</title>403 Forbidden' }])), (e) => e.status === 502 && /^E_OPENAIP_UNREACHABLE \(browser 403: <!doctype/.test(e.message));
  await assert.rejects(() => fetchAirspacesDirect([8.4, 47.3, 8.6, 47.5], 'k', async () => { throw new TypeError('Failed to fetch'); }), (e) => e.status === 502 && /browser 0: Failed to fetch/.test(e.message));
});
