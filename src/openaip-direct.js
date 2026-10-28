// openAIP straight from the browser – the fallback when the Worker proxy is refused.
// WHY: api.core.openaip.net answers requests from Cloudflare Workers with an HTML "403 Forbidden"
// page (seen 28.10.2026 with a fresh, valid key), while the same request from a browser works
// (cockpit.wicki.aero does exactly this, confirmed 11.08.2026 – openAIP sends CORS headers).
// The key reaches the browser only for logged-in ground users and only if the master allows it
// (setting openaipDirect, default on). Pure module: fetch is injected so it can be unit-tested.

export const OPENAIP_UPSTREAM = 'https://api.core.openaip.net/api/airspaces';
const Q = 0.2;                                    // same bbox quantisation as the Worker (one request per cell)
const MAX_PAGES = 4;

export function quantize(bbox) {
  const [w, s, e, n] = bbox;
  const r = (v) => Math.round(v / Q * 1e6) / 1e6;            // 47.4 / 0.2 is 236.99999… in floating point
  return [Math.floor(r(w)) * Q, Math.floor(r(s)) * Q, Math.ceil(r(e)) * Q, Math.ceil(r(n)) * Q].map((v) => Number(v.toFixed(1)));
}

/** Slim copy of an openAIP item – the same fields the Worker proxy returns. */
export const slim = (it) => ({ _id: it._id, name: it.name, type: it.type, icaoClass: it.icaoClass, lowerLimit: it.lowerLimit, upperLimit: it.upperLimit, geometry: it.geometry });

/**
 * Fetch all airspaces in bbox [w,s,e,n] with the key, paging like cockpit/ops.
 * Resolves {bbox, fetchedAt, via:'browser', items}; rejects with {status, message} in the Worker's
 * error vocabulary so the planning banner needs no new cases.
 */
export async function fetchAirspacesDirect(bbox, key, fetchFn = globalThis.fetch, { limit = 1000, timeoutMs = 12000 } = {}) {
  const q = quantize(bbox);
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${OPENAIP_UPSTREAM}?apiKey=${encodeURIComponent(key)}&bbox=${q.join(',')}&limit=${limit}&page=${page}`;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let res;
    try { res = await fetchFn(url, ctl ? { signal: ctl.signal } : undefined); }
    catch (e) { throw errorOf(0, String((e && e.message) || e)); }
    finally { if (timer) clearTimeout(timer); }
    if (!res.ok) throw errorOf(res.status, await res.text().catch(() => ''));
    const data = await res.json();
    items.push(...(data.items || []).map(slim));
    const total = Number(data.totalPages || 0);
    if (!total || page >= total) break;
  }
  return { bbox: q, fetchedAt: Date.now(), via: 'browser', items };
}

function errorOf(status, body) {
  const excerpt = String(body || '').replace(/\s+/g, ' ').slice(0, 90);
  const keyRejected = status === 401 || (status === 403 && /^\s*\{/.test(excerpt));
  const err = new Error(`${keyRejected ? 'E_OPENAIP_KEY_REJECTED' : 'E_OPENAIP_UNREACHABLE'} (browser ${status}${excerpt ? ': ' + excerpt : ''})`);
  err.status = keyRejected ? 409 : 502;
  return err;
}
