// openAIP proxy: the browser cannot call api.core.openaip.net directly (no CORS headers) and the
// API key must stay on the server. Responses are cached per 0.2°-quantised bbox for 24 h in the
// Cloudflare cache so a whole planning session costs one upstream request.
import { HttpError } from './auth.js';
import { getSettings } from './users.js';

const Q = 0.2;                 // bbox quantisation (degrees) – same trick as s2planning
const TTL_S = 24 * 3600;
const UPSTREAM = 'https://api.core.openaip.net/api/airspaces';

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

  const up = `${UPSTREAM}?bbox=${bbox.join(',')}&limit=1000`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  let res;
  try {
    res = await fetch(up, { headers: { 'x-openaip-api-key': key, Accept: 'application/json' }, signal: ctl.signal });
  } catch (err) {
    throw new HttpError(502, 'E_OPENAIP_UNREACHABLE');
  } finally { clearTimeout(timer); }
  if (res.status === 401 || res.status === 403) throw new HttpError(409, 'E_OPENAIP_KEY_REJECTED');
  if (!res.ok) throw new HttpError(502, `E_OPENAIP_${res.status}`);
  const data = await res.json();
  // keep only what the client needs – geometry, limits, type, name – to stay small
  const items = (data.items || []).map((it) => ({ _id: it._id, name: it.name, type: it.type, icaoClass: it.icaoClass, lowerLimit: it.lowerLimit, upperLimit: it.upperLimit, geometry: it.geometry }));
  const out = new Response(JSON.stringify({ bbox: bbox.map(Number), fetchedAt: Date.now(), items }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${TTL_S}` },
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, out.clone())); else await cache.put(cacheKey, out.clone());
  return out;
}
