// Regional airspace file (openAIP nightly export, built by tools/build-airspaces.mjs, published on
// the repository's `data` branch). Primary airspace source of the app.
// WHY: openAIP refuses live calls from the Cloudflare Worker (HTML 403) and from browsers (no CORS),
// both seen 28.10.2026; the keyless exports are the route openAIP offers for programs. The file is
// loaded once per session (HTTP cache of raw.githubusercontent.com: 5 min) and filtered by bbox here.
// Pure module: fetch and the URL are injected so it can be unit-tested.

let loaded = null;                 // Promise<{meta, items}> for the session

/** Bounding box [w,s,e,n] of a (Multi)Polygon geometry, or null. */
export function geometryBbox(geom) {
  if (!geom || !geom.coordinates) return null;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : geom.type === 'Polygon' ? [geom.coordinates] : null;
  if (!polys) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polys) for (const ring of poly) for (const [x, y] of ring) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

export const bboxIntersects = (a, b) => !!a && !!b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
/** True when the requested bbox lies completely inside the file's region (otherwise the live routes are asked). */
export const coversBbox = (region, bbox) => !!region && !!bbox && bbox[0] >= region[0] && bbox[1] >= region[1] && bbox[2] <= region[2] && bbox[3] <= region[3];

/** Parse a regional file: items get their bbox precomputed once. */
export function parseRegionFile(data) {
  const items = (data.items || []).map((it) => ({ ...it, _bbox: geometryBbox(it.geometry) })).filter((it) => it._bbox);
  const meta = { generated: data.generated, generatedMs: Date.parse(data.generated) || 0, source: data.source, region: data.region, countries: data.countries || [], count: items.length, failed: data.failed || [] };
  return { meta, items };
}

export const filterByBbox = (items, bbox) => items.filter((it) => bboxIntersects(it._bbox, bbox));

/** Load (once per session) the regional file; rejects when it cannot be fetched or parsed. */
export function loadRegionFile(url, fetchFn = globalThis.fetch, { force = false } = {}) {
  if (!loaded || force) {
    loaded = (async () => {
      const res = await fetchFn(url, { cache: 'default' });
      if (!res.ok) throw new Error(`E_AIRSPACE_FILE (${res.status})`);
      return parseRegionFile(await res.json());
    })();
    loaded.catch(() => { loaded = null; });          // a failed load is retried next time
  }
  return loaded;
}

/**
 * Airspaces for bbox [w,s,e,n] from the regional file, in the Worker's answer shape
 * ({bbox, fetchedAt, via:'export', generated, items}) – or null when the file does not cover the bbox.
 */
export async function airspacesFromFile(bbox, url, fetchFn) {
  const { meta, items } = await loadRegionFile(url, fetchFn);
  if (!coversBbox(meta.region, bbox)) return null;
  return { bbox, fetchedAt: meta.generatedMs, via: 'export', generated: meta.generated, countries: meta.countries, items: filterByBbox(items, bbox).map(({ _bbox, ...it }) => it) };
}
