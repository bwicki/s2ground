#!/usr/bin/env node
// Builds the regional airspace file from openAIP's nightly, keyless country exports.
// WHY: api.core.openaip.net refuses Cloudflare-Worker requests (HTML 403) and sends no CORS headers
// to browsers (both seen 28.10.2026), so the app cannot query it live. The exports are the route
// openAIP offers for programs: https://s3.openaip.net/openaip-system-exports/<cc>_asp.geojson
// (nightly, no key, rate limit 20 req/s). This script keeps only the airspaces that touch REGION,
// slims every feature to what the app needs (src/planning.js fromOpenAip) and rounds coordinates.
// Run by .github/workflows/airspaces.yml every night; the result goes to the `data` branch.
//
//   REGION="5.5,45.3,11.0,48.2" COUNTRIES="ch,li,de,at,fr,it" OUT=airspaces-region.json node tools/build-airspaces.mjs
//
import { writeFile } from 'node:fs/promises';

export const EXPORT_BASE = 'https://s3.openaip.net/openaip-system-exports';
export const DEFAULT_REGION = [5.5, 45.3, 11.0, 48.2];          // Switzerland + ~80 km
export const DEFAULT_COUNTRIES = ['ch', 'de', 'at', 'fr', 'it'];   // no li_asp export exists – Liechtenstein's airspace is in the CH file
const DECIMALS = 4;                                               // ≈ 11 m – plenty for airspace boundaries

/** Bounding box [w,s,e,n] of a (Multi)Polygon geometry, or null. */
export function geometryBbox(geom) {
  if (!geom || !geom.coordinates) return null;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : geom.type === 'Polygon' ? [geom.coordinates] : null;
  if (!polys) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polys) for (const ring of poly) for (const [x, y] of ring) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

export const bboxIntersects = (a, b) => a && b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

const round = (v) => Number(v.toFixed(DECIMALS));
function roundGeometry(geom) {
  const r = (ring) => ring.map(([x, y]) => [round(x), round(y)]);
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(r) };
  return { type: 'MultiPolygon', coordinates: geom.coordinates.map((poly) => poly.map(r)) };
}

/** One export feature (or API item) → the slim item the app consumes, or null when outside/unusable. */
export function slimFeature(f, region) {
  const p = f.properties || f;                                   // export: properties beside geometry; API: flat item
  const geom = f.geometry;
  const bb = geometryBbox(geom);
  if (!bb || !bboxIntersects(bb, region)) return null;
  return { _id: p._id || f.id || p.id || null, name: p.name, type: p.type, icaoClass: p.icaoClass, country: p.country, lowerLimit: p.lowerLimit, upperLimit: p.upperLimit, geometry: roundGeometry(geom) };
}

/** Merge several country FeatureCollections into the regional file (deduplicated by _id/name). */
export function buildRegion(collections, region = DEFAULT_REGION, countries = DEFAULT_COUNTRIES) {
  const seen = new Set(); const items = [];
  for (const fc of collections) {
    for (const f of fc.features || fc.items || []) {
      const it = slimFeature(f, region);
      if (!it) continue;
      const key = it._id || `${it.name}|${it.type}|${it.country}`;
      if (seen.has(key)) continue;
      seen.add(key); items.push(it);
    }
  }
  items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { generated: new Date().toISOString(), source: `openAIP daily export (${EXPORT_BASE})`, region, countries, count: items.length, items };
}

async function fetchCountry(cc) {
  const url = `${EXPORT_BASE}/${cc}_asp.geojson`;
  const res = await fetch(url, { headers: { 'User-Agent': 's2ground-airspaces/1.0 (+https://s2ground.wicki.aero)', Accept: 'application/geo+json, application/json' } });
  if (!res.ok) throw new Error(`${cc}: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const region = (process.env.REGION || '').split(',').map(Number).filter(Number.isFinite);
  const reg = region.length === 4 ? region : DEFAULT_REGION;
  const countries = (process.env.COUNTRIES || DEFAULT_COUNTRIES.join(',')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = process.env.OUT || 'airspaces-region.json';
  const collections = []; const failed = [];
  for (const cc of countries) {
    try { const fc = await fetchCountry(cc); collections.push(fc); console.log(`${cc}: ${(fc.features || []).length} features`); }
    catch (e) { failed.push(cc); console.error(`${cc}: ${e.message}`); }
  }
  if (!collections.length) { console.error('no export could be downloaded'); process.exit(1); }
  const data = buildRegion(collections, reg, countries.filter((c) => !failed.includes(c)));
  if (failed.length) data.failed = failed;
  await writeFile(out, JSON.stringify(data));
  console.log(`${out}: ${data.count} airspaces in region ${reg.join(',')} (${(JSON.stringify(data).length / 1e6).toFixed(1)} MB)${failed.length ? `, failed: ${failed.join(',')}` : ''}`);
  if (failed.length && failed.includes('ch')) process.exit(1);     // Switzerland missing = not usable
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main().catch((e) => { console.error(e); process.exit(1); });
