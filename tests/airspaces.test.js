// node --test: the openAIP proxy – the request variants, how a refusal is reported and the master-only
// key test. Uses a fake env.DB and a fake global fetch; no network, no Durable Object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airspaces, testOpenAipKey, VARIANTS, keyFingerprint, openAipKey } from '../worker/src/airspaces.js';
import { HttpError } from '../worker/src/auth.js';

const envWith = (openaipKey) => ({ DB: { prepare: () => ({ first: async () => ({ value: JSON.stringify({ openaipKey }) }) }) } });
const noCache = { match: async () => undefined, put: async () => {} };
const bboxUrl = new URL('https://x/api/airspaces?bbox=8.4,47.3,8.6,47.5');
const HTML403 = '<!doctype html><meta charset="utf-8"><title>403</title>403 Forbidden';

/** Fake fetch answering per attempt from a script: [{status, body}] in call order (last entry repeats). */
function scripted(script, seen = []) {
  return async (url, init) => {
    const step = script[Math.min(seen.length, script.length - 1)];
    seen.push({ url: String(url), headers: init.headers });
    const body = typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
    return new Response(body, { status: step.status, headers: { 'Content-Type': 'application/json' } });
  };
}

test('variants: header+own UA (as ops) → header only → header+apiKey+UA; first success wins', async () => {
  const seen = []; const orig = globalThis.fetch;
  globalThis.fetch = scripted([{ status: 403, body: HTML403 }, { status: 403, body: HTML403 }, { status: 200, body: { items: [{ _id: 'a', name: 'LS-R12' }] } }], seen);
  globalThis.caches = { default: noCache };
  try {
    const res = await airspaces(envWith(' abc123 '), bboxUrl, null);
    assert.equal(seen.length, 3);
    assert.equal(new URL(seen[0].url).searchParams.get('apiKey'), null);
    assert.equal(seen[0].headers['x-openaip-api-key'], 'abc123');           // trimmed, always as header
    assert.match(seen[0].headers['User-Agent'], /^s2ground\/1\.0 \(\+https:\/\/s2ground\.wicki\.aero\)$/);   // own name, nothing spoofed
    assert.equal(seen[1].headers['User-Agent'], undefined);
    assert.equal(new URL(seen[2].url).searchParams.get('apiKey'), 'abc123');
    const data = await res.json();
    assert.equal(data.via, VARIANTS[2].via); assert.equal(data.items[0].name, 'LS-R12');
  } finally { globalThis.fetch = orig; }
});

test('key source: settings first, then the Worker secret OPENAIP_KEY; fingerprint never contains the key', async () => {
  assert.deepEqual(await openAipKey(envWith('abc')), { key: 'abc', source: 'settings' });
  assert.deepEqual(await openAipKey({ ...envWith(''), OPENAIP_KEY: ' sec ' }), { key: 'sec', source: 'secret' });
  assert.deepEqual(await openAipKey(envWith('')), { key: '', source: null });
  assert.deepEqual(keyFingerprint('0123456789abcdef0123456789abcdef'), { keyLength: 32, keyHint: '0123…ef', keyFormatOk: true });
  assert.deepEqual(keyFingerprint('MeinPasswort12'), { keyLength: 14, keyHint: 'Mein…12', keyFormatOk: false });
  assert.deepEqual(keyFingerprint('short'), { keyLength: 5, keyHint: '', keyFormatOk: false });
});

test('JSON 401 from the API → 409 E_OPENAIP_KEY_REJECTED at once (no further variants)', async () => {
  const seen = []; const orig = globalThis.fetch;
  globalThis.fetch = scripted([{ status: 401, body: { message: 'Unauthorized' } }], seen);
  globalThis.caches = { default: noCache };
  try {
    await assert.rejects(() => airspaces(envWith('bad'), bboxUrl, null),
      (e) => e instanceof HttpError && e.status === 409 && /^E_OPENAIP_KEY_REJECTED \(header\+ua 401: .*Unauthorized/.test(e.message));
    assert.equal(seen.length, 1);
  } finally { globalThis.fetch = orig; }
});

test('HTML 403 on every variant → 502 E_OPENAIP_UNREACHABLE listing each attempt; no key → 409', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = scripted([{ status: 403, body: HTML403 }]);
  globalThis.caches = { default: noCache };
  try {
    await assert.rejects(() => airspaces(envWith('k'), bboxUrl, null), (e) => e.status === 502 && /^E_OPENAIP_UNREACHABLE \(header\+ua 403: .*; header 403: .*; header\+query\+ua 403: /.test(e.message));
    await assert.rejects(() => airspaces(envWith(''), bboxUrl, null), (e) => e.status === 409 && e.message === 'E_OPENAIP_KEY_REJECTED' || e.message === 'E_NO_OPENAIP_KEY');
  } finally { globalThis.fetch = orig; }
});

test('key test reports every attempt and never throws', async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = scripted([{ status: 200, body: { items: [{}, {}] } }]);
    const ok = await testOpenAipKey(envWith('abcdef'));
    assert.equal(ok.ok, true); assert.equal(ok.count, 2); assert.equal(ok.via, 'header+ua'); assert.equal(ok.keyLength, 6); assert.equal(ok.source, 'settings'); assert.equal(ok.keyFormatOk, false); assert.equal(ok.tried.length, 1);
    globalThis.fetch = scripted([{ status: 403, body: HTML403 }]);
    const r = await testOpenAipKey(envWith('abcdef'));
    assert.equal(r.ok, false); assert.equal(r.status, 502); assert.match(r.message, /^E_OPENAIP_UNREACHABLE/); assert.equal(r.tried.length, 3); assert.equal(r.keyHint, ''); assert.equal(r.keyLength, 6);   // hint only from 8 characters
    assert.deepEqual(await testOpenAipKey(envWith('')), { ok: false, status: 0, message: 'E_NO_OPENAIP_KEY', source: null, tried: [], keyLength: 0, keyHint: '', keyFormatOk: false });
    globalThis.fetch = async () => { throw new TypeError('network'); };
    const n = await testOpenAipKey(envWith('abcdef'));
    assert.equal(n.ok, false); assert.equal(n.tried[0].status, 0); assert.match(n.tried[0].body, /network/);
  } finally { globalThis.fetch = orig; }
});

test('browser key route: ground users get the key only while openaipDirect is on', async () => {
  const { airspaceKeyForBrowser } = await import('../worker/src/airspaces.js');
  const env = (settings) => ({ DB: { prepare: () => ({ first: async () => ({ value: JSON.stringify(settings) }) }) } });
  assert.deepEqual(await airspaceKeyForBrowser(env({ openaipKey: 'abc', openaipDirect: true })), { key: 'abc' });
  await assert.rejects(() => airspaceKeyForBrowser(env({ openaipKey: 'abc', openaipDirect: false })), (e) => e.status === 403 && e.message === 'E_DIRECT_DISABLED');
  await assert.rejects(() => airspaceKeyForBrowser(env({ openaipKey: '', openaipDirect: true })), (e) => e.status === 409 && e.message === 'E_NO_OPENAIP_KEY');
});
