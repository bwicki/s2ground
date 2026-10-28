// node --test: the openAIP proxy – how the key is sent, how an upstream refusal is reported and the
// master-only key test. Uses a fake env.DB and a fake global fetch; no network, no Durable Object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airspaces, testOpenAipKey } from '../worker/src/airspaces.js';
import { HttpError } from '../worker/src/auth.js';

const envWith = (openaipKey) => ({ DB: { prepare: () => ({ first: async () => ({ value: JSON.stringify({ openaipKey }) }) }) } });
const noCache = { match: async () => undefined, put: async () => {} };

function fakeFetch(status, body, seen) {
  return async (url, init) => {
    seen.url = url; seen.init = init;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
}

test('openAIP key goes out as header AND apiKey query parameter, with a User-Agent', async () => {
  const seen = {}; const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch(200, { items: [{ _id: 'a', name: 'LS-R12', type: 1, lowerLimit: {}, upperLimit: {}, geometry: {} }] }, seen);
  globalThis.caches = { default: noCache };
  try {
    const res = await airspaces(envWith(' abc123 '), new URL('https://x/api/airspaces?bbox=8.4,47.3,8.6,47.5'), null);
    const u = new URL(seen.url);
    assert.equal(u.searchParams.get('apiKey'), 'abc123');                       // trimmed
    assert.equal(seen.init.headers['x-openaip-api-key'], 'abc123');
    assert.match(seen.init.headers['User-Agent'], /s2ground/);
    const data = await res.json();
    assert.equal(data.items.length, 1); assert.equal(data.items[0].name, 'LS-R12');
  } finally { globalThis.fetch = orig; }
});

test('401/403 from openAIP → 409 E_OPENAIP_KEY_REJECTED with the upstream answer appended', async () => {
  const seen = {}; const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch(401, { message: 'Unauthorized' }, seen);
  globalThis.caches = { default: noCache };
  try {
    await assert.rejects(() => airspaces(envWith('bad'), new URL('https://x/api/airspaces?bbox=8.4,47.3,8.6,47.5'), null),
      (e) => e instanceof HttpError && e.status === 409 && /^E_OPENAIP_KEY_REJECTED \(openAIP 401: .*Unauthorized/.test(e.message));
  } finally { globalThis.fetch = orig; }
});

test('other upstream errors → 502 E_OPENAIP_<status>; no key → 409 E_NO_OPENAIP_KEY', async () => {
  const seen = {}; const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch(503, 'Service Unavailable', seen);
  globalThis.caches = { default: noCache };
  try {
    await assert.rejects(() => airspaces(envWith('k'), new URL('https://x/api/airspaces?bbox=8.4,47.3,8.6,47.5'), null), (e) => e.status === 502 && e.message.startsWith('E_OPENAIP_503'));
    await assert.rejects(() => airspaces(envWith(''), new URL('https://x/api/airspaces?bbox=8.4,47.3,8.6,47.5'), null), (e) => e.status === 409 && e.message === 'E_NO_OPENAIP_KEY');
  } finally { globalThis.fetch = orig; }
});

test('key test returns {ok, count} or {ok:false, message} instead of throwing', async () => {
  const seen = {}; const orig = globalThis.fetch;
  try {
    globalThis.fetch = fakeFetch(200, { items: [{}, {}] }, seen);
    assert.deepEqual(await testOpenAipKey(envWith('abcdef')), { ok: true, status: 200, count: 2, keyLength: 6 });
    globalThis.fetch = fakeFetch(403, { message: 'Forbidden' }, seen);
    const r = await testOpenAipKey(envWith('abcdef'));
    assert.equal(r.ok, false); assert.equal(r.status, 403); assert.match(r.message, /^E_OPENAIP_KEY_REJECTED/);
    assert.deepEqual(await testOpenAipKey(envWith('')), { ok: false, status: 0, message: 'E_NO_OPENAIP_KEY' });
    globalThis.fetch = async () => { throw new TypeError('network'); };
    assert.equal((await testOpenAipKey(envWith('abcdef'))).message, 'E_OPENAIP_UNREACHABLE');
  } finally { globalThis.fetch = orig; }
});
