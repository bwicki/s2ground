// Place names. Everywhere in the app a place is written «CC-Ort» – ISO 3166-1 alpha-2 country code,
// hyphen, locality – e.g. CH-Baden, DE-Baden-Baden, AT-Baden. WHY: the same name exists in several
// countries; the code makes the choice visible at a glance (same convention as the owner's other apps).
// Source: OSM Nominatim (search with all candidates, reverse for a position). Pure functions take an
// injected fetch so they can be unit-tested; the usage policy asks for ≤ 1 request/s – the dialog debounces.

export const NOMINATIM = 'https://nominatim.openstreetmap.org';
const HEADERS = { Accept: 'application/json' };

/** The locality from a Nominatim address object (most specific first), or the fallback. */
export function placeName(address, fallback = '') {
  const a = address || {};
  return a.city || a.town || a.village || a.municipality || a.hamlet || a.locality || a.suburb || a.city_district || a.county || fallback;
}

/** «CC-Ort» for one Nominatim result (search or reverse). */
export function placeLabel(item) {
  if (!item) return '';
  const a = item.address || {};
  const cc = String(a.country_code || '').toUpperCase();
  const first = String(item.display_name || item.name || '').split(',')[0].trim();
  const name = placeName(a, first);
  return cc ? `${cc}-${name}` : name;
}

/** Region line shown under a candidate: state/canton (and county when it adds something). */
export function placeRegion(item) {
  const a = (item && item.address) || {};
  const parts = [a.state || a.region || '', a.county && a.county !== a.state ? a.county : ''].filter(Boolean);
  return parts.join(' · ');
}

/** Search results → distinct candidates [{label, region, lat, lon, type}], order kept (Nominatim ranks by importance). */
export function candidatesFrom(items) {
  const out = []; const seen = new Set();
  for (const it of items || []) {
    const label = placeLabel(it); const region = placeRegion(it);
    const key = `${label}|${region}`;
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push({ label, region, lat: +it.lat, lon: +it.lon, type: it.addresstype || it.type || '' });
  }
  return out;
}

/** All places matching q (several countries possible) – the user picks; nothing is chosen automatically. */
export async function searchPlaces(q, fetchFn = globalThis.fetch, { limit = 10, lang = 'de' } = {}) {
  const url = `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=${limit}&accept-language=${lang}&q=${encodeURIComponent(q)}`;
  const r = await fetchFn(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`geocode ${r.status}`);
  return candidatesFrom(await r.json());
}

/** «CC-Ort» for a position (zoom 14 = town/village level), or null when nothing is known there. */
export async function reversePlace(lat, lon, fetchFn = globalThis.fetch, { lang = 'de' } = {}) {
  const url = `${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&zoom=14&accept-language=${lang}&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`;
  const r = await fetchFn(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`reverse ${r.status}`);
  const j = await r.json();
  return j && j.address ? placeLabel(j) : null;
}

/** Fire-and-forget reverse lookup with a per-position memo, for places the app sets itself (RR4 GPS, crosshair). */
const memo = new Map();
export async function placeFor(lat, lon, fetchFn) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;           // ~100 m – one lookup per spot
  if (!memo.has(key)) memo.set(key, reversePlace(lat, lon, fetchFn).catch(() => null));
  return memo.get(key);
}
