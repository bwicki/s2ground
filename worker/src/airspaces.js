// openAIP proxy: the browser cannot call api.core.openaip.net directly (no CORS headers) and the
// API key must stay on the server. Responses are cached per 0.2°-quantised bbox for 24 h in the
// Cloudflare cache so a whole planning session costs one upstream request.
import { HttpError } from './auth.js';
import { getSettings } from './users.js';

const Q = 0.2;                 // bbox quantisation (degrees) – same trick as s2planning
const TTL_S = 24 * 3600;
const UPSTREAM = 'https://api.core.openaip.net/api/airspaces';

/**
 * One request to openAIP. The key is sent BOTH as the documented header and as the `apiKey` query
 * parameter (the owner's s2planning app uses the query form successfully) – whichever the API honours.
 * A User-Agent is set because some gateways answer 403 to anonymous Worker fetches.
 */
async function fetchOpenAip(key, upstreamUrl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const u = new URL(upstreamUrl); u.searchParams.set('apiKey', key);
    return await fetch(u.toString(), { headers: { 'x-openaip-api-key': key, Accept: 'application/json', 'User-Agent': 's2ground/1.0 (+https://s2ground.wicki.aero)' }, signal: ctl.signal });
  } catch (err) {
    throw new HttpError(502, 'E_OPENAIP_UNREACHABLE');
  } finally { clearTimeout(timer); }
}

/** Error code + what openAIP actually answered (status and the first 160 characters), so the admin can see why. */
async function describe(res) {
  let body = '';
  try { body = (await res.text()).replace(/\s+/g, ' ').slice(0, 160); } catch { body = ''; }
  const code = res.status === 401 || res.status === 403 ? 'E_OPENAIP_KEY_REJECTED' : `E_OPENAIP_${res.status}`;
  return `${code} (openAIP ${res.status}${body ? ': ' + body : ''})`;
}

/** Master-only key test: a tiny request; returns {ok, status, message} instead of throwing. */
export async function testOpenAipKey(env) {
  const settings = await getSettings(env);
  const key = (settings.openaipKey || '').trim();
  if (!key) return { ok: false, status: 0, message: 'E_NO_OPENAIP_KEY' };
  try {
    const res = await fetchOpenAip(key, `${UPSTREAM}?bbox=8.4,47.3,8.6,47.5&limit=1`);
    if (!res.ok) return { ok: false, status: res.status, message: await describe(res) };
    const data = await res.json();
    return { ok: true, status: res.status, count: Array.isArray(data.items) ? data.items.length : 0, keyLength: key.length };
  } catch (e) {
    return { ok: false, status: 0, message: e.message || 'E_OPENAIP_UNREACHABLE' };
  }
}

export async function airspaces(env, url, ctx) {
  const raw = (url.searchParams.get('bbox') || '').split(',').map(Number);
  if (raw.length !== 4 || raw.some((v) => !Number.isFinite(v))) throw new HttpError(400, 'bbox=w,s,e,n required');
  const [w, s, e, n] = raw;
  if (e - w > 4 || n - s > 3) throw new HttpError(400, 'bbox too large');
  const bbox = [Math.floor(w / Q) * Q, Math.floor(s / Q) * Q, Math.ceil(e / Q) * Q, Math.ceil(n / Q) * Q].map((v) => v.toFixed(1));

  const settings = await getSettings(env);
  const key = (settings.openaipKey || '').trim();
  if (!key) throw new HttpError(409, 'E_NO_OPENAIP_KEY');            // the admin page explains what to do

  const cacheKey = new Request(`https://cache.s2ground.local/airspaces?bbox=${bbox.join(',')}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const res = await fetchOpenAip(key, `${UPSTREAM}?bbox=${bbox.join(',')}&limit=1000`);
  if (!res.ok) throw new HttpError(res.status === 401 || res.status === 403 ? 409 : 502, await describe(res));
  const data = await res.json();
  // keep only what the client needs – geometry, limits, type, name – to stay small
  const items = (data.items || []).map((it) => ({ _id: it._id, name: it.name, type: it.type, icaoClass: it.icaoClass, lowerLimit: it.lowerLimit, upperLimit: it.upperLimit, geometry: it.geometry }));
  const out = new Response(JSON.stringify({ bbox: bbox.map(Number), fetchedAt: Date.now(), items }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${TTL_S}` },
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, out.clone())); else await cache.put(cacheKey, out.clone());
  return out;
}
