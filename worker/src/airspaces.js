// openAIP proxy: the browser cannot call api.core.openaip.net directly (no CORS headers) and the
// API key must stay on the server. Responses are cached per 0.2°-quantised bbox for 24 h in the
// Cloudflare cache so a whole planning session costs one upstream request.
import { HttpError } from './auth.js';
import { getSettings } from './users.js';

const Q = 0.2;                 // bbox quantisation (degrees) – same trick as s2planning
const TTL_S = 24 * 3600;
const UPSTREAM = 'https://api.core.openaip.net/api/airspaces';

/**
 * How the Worker reaches openAIP.
 * In production (28.10.2026) api.core.openaip.net answered the Worker's request with an HTML "403 Forbidden"
 * page – a gateway refusal, not the API's own JSON 401 for a wrong key. To find out which part of the
 * request the gateway objects to, three honest variants are tried in turn (no spoofing: either no
 * User-Agent at all or the app's own name) and every attempt is recorded so the admin's key test shows
 * exactly what openAIP answered. The variant that works is used for the real request.
 */
const UA_APP = 's2ground/1.0 (+https://s2ground.wicki.aero)';
export const VARIANTS = [
  { via: 'header+ua',    query: false, ua: UA_APP },  // exactly what the ops.wicki.aero Worker sends (works there)
  { via: 'header',       query: false, ua: null },    // documented header only, no User-Agent
  { via: 'header+query+ua', query: true, ua: UA_APP },// + apiKey query parameter (as s2planning sends it)
];
const TIMEOUT_MS = 9000;

function upstreamUrl(key, params, withQuery) {
  const u = new URL(UPSTREAM);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (withQuery) u.searchParams.set('apiKey', key);
  return u.toString();
}

/** One attempt with one variant → {via, ok, status, ms, data, body}; never throws. */
async function fetchVariant(v, key, params) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const headers = { Accept: 'application/json, text/plain, */*', 'x-openaip-api-key': key };
  if (v.ua) headers['User-Agent'] = v.ua;
  const t0 = Date.now();
  try {
    const res = await fetch(upstreamUrl(key, params, v.query), { headers, signal: ctl.signal, redirect: 'follow' });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    const ok = res.ok && !!data && Array.isArray(data.items);
    return { via: v.via, ok, status: res.status, ms: Date.now() - t0, data, body: ok ? '' : text.replace(/\s+/g, ' ').slice(0, 160) };
  } catch (e) {
    return { via: v.via, ok: false, status: 0, ms: Date.now() - t0, data: null, body: String((e && e.message) || e).slice(0, 160) };
  } finally { clearTimeout(timer); }
}

/** Try the variants in order until one answers with items → {ok, via, status, data, tried[]}. */
async function fetchAny(key, params) {
  const tried = [];
  for (const v of VARIANTS) {
    const r = await fetchVariant(v, key, params);
    tried.push({ via: r.via, ok: r.ok, status: r.status, ms: r.ms, body: r.body });
    if (r.ok) return { ok: true, via: r.via, status: r.status, data: r.data, tried };
    if (r.status === 401) break;                                   // the API itself refused the key – no variant changes that
  }
  return { ok: false, tried };
}

/** Error code + what every attempt answered, e.g. "E_OPENAIP_UNREACHABLE (header 403: <!doctype …; …)". */
function describe(tried) {
  // JSON 401/403 = the API itself refused the key; an HTML 403 or a network error = gateway block / unreachable
  const keyRejected = tried.some((t) => t.status === 401 || (t.status === 403 && /^\s*\{/.test(t.body)));
  const code = keyRejected ? 'E_OPENAIP_KEY_REJECTED' : 'E_OPENAIP_UNREACHABLE';
  const parts = tried.map((t) => `${t.via} ${t.status}${t.body ? ': ' + t.body.slice(0, 90) : ''}`);
  return { code, status: keyRejected ? 409 : 502, message: `${code} (${parts.join('; ')})` };
}

/**
 * Where the key comes from: the master's App-Einstellungen (D1, masked towards the browser) or – if that is
 * empty – the Worker secret OPENAIP_KEY (set from the GitHub secret of the same name by the deploy workflow).
 */
export async function openAipKey(env) {
  const settings = await getSettings(env);
  const fromSettings = String(settings.openaipKey || '').trim();
  if (fromSettings) return { key: fromSettings, source: 'settings' };
  const fromSecret = String(env.OPENAIP_KEY || '').trim();
  return fromSecret ? { key: fromSecret, source: 'secret' } : { key: '', source: null };
}

/**
 * Fingerprint of the stored key so the master can compare it with openaip.net without the key ever leaving
 * the Worker: length, first 4 + last 2 characters, and whether it looks like an openAIP key (32 hex characters;
 * a browser that auto-filled a saved password into the field produces something quite different).
 */
export function keyFingerprint(key) {
  const k = String(key || '');
  return { keyLength: k.length, keyHint: k.length >= 8 ? `${k.slice(0, 4)}…${k.slice(-2)}` : '', keyFormatOk: /^[a-f0-9]{32}$/i.test(k) };
}

/** Master-only key test: a tiny request; returns a report with every attempt, never throws. */
export async function testOpenAipKey(env) {
  const { key, source } = await openAipKey(env);
  if (!key) return { ok: false, status: 0, message: 'E_NO_OPENAIP_KEY', source, tried: [], ...keyFingerprint('') };
  const fp = { source, ...keyFingerprint(key) };
  const r = await fetchAny(key, { bbox: '8.4,47.3,8.6,47.5', limit: '1' });
  if (r.ok) return { ok: true, via: r.via, status: r.status, count: r.data.items.length, tried: r.tried, ...fp };
  const d = describe(r.tried);
  return { ok: false, status: d.status, message: d.message, tried: r.tried, ...fp };
}

export async function airspaces(env, url, ctx) {
  const raw = (url.searchParams.get('bbox') || '').split(',').map(Number);
  if (raw.length !== 4 || raw.some((v) => !Number.isFinite(v))) throw new HttpError(400, 'bbox=w,s,e,n required');
  const [w, s, e, n] = raw;
  if (e - w > 4 || n - s > 3) throw new HttpError(400, 'bbox too large');
  const bbox = [Math.floor(w / Q) * Q, Math.floor(s / Q) * Q, Math.ceil(e / Q) * Q, Math.ceil(n / Q) * Q].map((v) => v.toFixed(1));

  const { key } = await openAipKey(env);
  if (!key) throw new HttpError(409, 'E_NO_OPENAIP_KEY');            // the admin page explains what to do

  const cacheKey = new Request(`https://cache.s2ground.local/airspaces?bbox=${bbox.join(',')}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const r = await fetchAny(key, { bbox: bbox.join(','), limit: '1000' });
  if (!r.ok) { const d = describe(r.tried); throw new HttpError(d.status, d.message); }
  const data = r.data;
  // keep only what the client needs – geometry, limits, type, name – to stay small
  const items = (data.items || []).map((it) => ({ _id: it._id, name: it.name, type: it.type, icaoClass: it.icaoClass, lowerLimit: it.lowerLimit, upperLimit: it.upperLimit, geometry: it.geometry }));
  const out = new Response(JSON.stringify({ bbox: bbox.map(Number), fetchedAt: Date.now(), via: r.via, items }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${TTL_S}` },
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, out.clone())); else await cache.put(cacheKey, out.clone());
  return out;
}
