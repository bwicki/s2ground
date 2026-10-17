// Trajectory prediction STUB for phase 1 ("Aufstieg planen").
// Good enough for a plausible plan in the field and for the Soll-Ist comparison during the ascent;
// NOT a replacement for s2planning. Everything here is pure JS (no DOM) so node tests can run it.
//
// Airspaces come live from openAIP through the Worker proxy (/api/airspaces, key stays server-side);
// fromOpenAip() converts the openAIP items into the internal shape used by the conflict check and the
// map/vertical views. Wind: Open-Meteo pressure levels (fallback: constant profile from settings).

import { destPoint, distanceM, bearingDeg, isaPressure, isaAltitude } from './util/format.js';

const G = 9.80665;
const RHO_AIR0 = 1.225;          // kg/m³ sea level ISA
const RHO_GAS = 0.1785;          // kg/m³ helium (balloon gas is mostly helium)
const CD = 0.40;                 // drag coefficient of a small latex balloon (fits Windsond's table)

// ---- atmosphere -----------------------------------------------------------------------------

/** ISA temperature (°C) and density (kg/m³) at altitude. */
export function isa(altM) {
  const tK = 288.15 - 0.0065 * Math.min(altM, 11000);
  const rho = RHO_AIR0 * Math.pow(tK / 288.15, 4.2559);
  return { tC: tK - 273.15, rho };
}

// ---- balloon --------------------------------------------------------------------------------

/**
 * Net lift (g) needed for a target rise rate, from a drag balance on the inflated balloon.
 * v = sqrt(2·Fn·g / (ρ·Cd·A)); the balloon's cross-section depends on the gas volume, which
 * depends on the lift – solved by a short fixed-point iteration.
 * Returns {netLiftG, grossLiftG, gasL, diameterM}.
 */
export function liftForRiseRate(riseRate, balloonG = 9, payloadG = 14) {
  let net = 20; // g, start value
  for (let i = 0; i < 40; i++) {
    const massKg = (balloonG + payloadG + net) / 1000;
    const volume = massKg / (RHO_AIR0 - RHO_GAS);          // m³ of gas that lifts balloon+payload+net
    const r = Math.cbrt((3 * volume) / (4 * Math.PI));
    const area = Math.PI * r * r;
    // required net lift for riseRate: Fn = v²·ρ·Cd·A / (2g)
    const needKg = (riseRate * riseRate * RHO_AIR0 * CD * area) / (2 * G);
    const next = needKg * 1000;
    if (Math.abs(next - net) < 0.01) { net = next; break; }
    net = (net + next) / 2;
  }
  const massKg = (balloonG + payloadG + net) / 1000;
  const volume = massKg / (RHO_AIR0 - RHO_GAS);
  const diameterM = 2 * Math.cbrt((3 * volume) / (4 * Math.PI));
  return { netLiftG: net, grossLiftG: net + payloadG, gasL: volume * 1000, diameterM };
}

/**
 * Rough burst altitude (m AMSL) of a small latex balloon: the envelope bursts when the gas has
 * expanded to the burst diameter. TODO(planning): replace by a per-balloon-type table.
 */
export function burstAltitude(balloonG, gasL) {
  const burstD = balloonG <= 12 ? 0.70 : balloonG <= 30 ? 1.1 : 1.6;
  const d0 = 2 * Math.cbrt((3 * gasL / 1000) / (4 * Math.PI));
  const ratio = Math.pow(burstD / d0, 3);                   // volume expansion ratio ≈ p0/p
  return Math.round(isaAltitude(101325 / ratio) / 10) * 10;
}

// ---- wind profile ---------------------------------------------------------------------------

/** Fallback profile: constant surface wind veering 10°/km and strengthening with height. */
export function fallbackProfile(dir = 240, spd = 6, tSurface = 15, rhSurface = 70) {
  const levels = [];
  for (let alt = 0; alt <= 12000; alt += 500) {
    levels.push({
      altM: alt, dir: (dir + alt / 100) % 360, spd: spd + alt / 400,
      tC: tSurface - 0.0065 * alt, rh: Math.max(20, rhSurface - alt / 200), hPa: isaPressure(alt) / 100,
    });
  }
  return levels;
}

const OM_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200];

/**
 * Wind/temperature profile from Open-Meteo pressure levels for the launch hour.
 * Resolves with levels[] or null (offline, timeout, error). No API key, no personal data.
 */
export async function fetchOpenMeteo(lat, lon, timeMs, { timeoutMs = 5000, fetchFn = globalThis.fetch } = {}) {
  if (!fetchFn) return null;
  const vars = OM_LEVELS.flatMap((p) => [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `temperature_${p}hPa`, `relative_humidity_${p}hPa`, `geopotential_height_${p}hPa`]);
  const d = new Date(timeMs);
  const day = d.toISOString().slice(0, 10);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&hourly=${vars.join(',')}&wind_speed_unit=ms&timezone=UTC&start_date=${day}&end_date=${day}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    const hour = d.getUTCHours();
    const idx = Math.min(hour, (j.hourly.time || []).length - 1);
    if (idx < 0) return null;
    const levels = OM_LEVELS.map((p) => ({
      hPa: p,
      altM: j.hourly[`geopotential_height_${p}hPa`][idx],
      spd: j.hourly[`wind_speed_${p}hPa`][idx],
      dir: j.hourly[`wind_direction_${p}hPa`][idx],
      tC: j.hourly[`temperature_${p}hPa`][idx],
      rh: j.hourly[`relative_humidity_${p}hPa`][idx],
    })).filter((l) => l.altM !== null && l.spd !== null);
    levels.sort((a, b) => a.altM - b.altM);
    return levels.length >= 3 ? levels : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Linear interpolation of a profile at altitude (wind vector interpolated as u/v). */
export function profileAt(levels, altM) {
  if (!levels.length) return { dir: 0, spd: 0, tC: 15, rh: 50 };
  if (altM <= levels[0].altM) return levels[0];
  if (altM >= levels[levels.length - 1].altM) return levels[levels.length - 1];
  let i = 1;
  while (levels[i].altM < altM) i++;
  const a = levels[i - 1], b = levels[i];
  const f = (altM - a.altM) / (b.altM - a.altM);
  const toUV = (l) => ({ u: -l.spd * Math.sin((l.dir * Math.PI) / 180), v: -l.spd * Math.cos((l.dir * Math.PI) / 180) });
  const ua = toUV(a), ub = toUV(b);
  const u = ua.u + f * (ub.u - ua.u), v = ua.v + f * (ub.v - ua.v);
  const spd = Math.hypot(u, v);
  const dir = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
  return { altM, spd, dir, tC: a.tC + f * (b.tC - a.tC), rh: a.rh + f * (b.rh - a.rh) };
}

// ---- trajectory -----------------------------------------------------------------------------

/**
 * Predict the flight. opts: {start:{lat,lon,alt}, launchMs, riseRate, descentRate, cutAltAgl|null,
 * burstAltAmsl, levels, dt=10}. Returns {points, cutdown, landing, maxAlt, ascentS, totalS, distanceM, bearing}.
 * Terrain is assumed flat at start.alt (TODO(planning): DEM lookup for the landing point).
 */
export function predict(opts) {
  const { start, launchMs = Date.now(), riseRate = 2.5, descentRate = 5, levels, dt = 10 } = opts;
  const top = opts.cutAltAgl != null ? start.alt + opts.cutAltAgl : (opts.burstAltAmsl || 10000);
  const points = [];
  let lat = start.lat, lon = start.lon, alt = start.alt, t = 0, phase = 'ascent';
  const step = (vz) => {
    const w = profileAt(levels, alt);
    const p = destPoint(lat, lon, (w.dir + 180) % 360, w.spd * dt);   // wind blows TO dir+180
    lat = p.lat; lon = p.lon; alt += vz * dt; t += dt;
  };
  points.push({ t: 0, lat, lon, alt, phase });
  // ascent
  while (alt < top && t < 6 * 3600) {
    step(riseRate);
    if (alt > top) alt = top;
    points.push({ t, lat, lon, alt, phase });
  }
  const cutdown = { t, lat, lon, alt, ms: launchMs + t * 1000, kind: opts.cutAltAgl != null ? 'cutdown' : 'burst' };
  const ascentS = t;
  phase = 'descent';
  // descent: terminal velocity scales with sqrt(rho0/rho)
  while (alt > start.alt && t < 12 * 3600) {
    const vz = -descentRate * Math.sqrt(RHO_AIR0 / isa(alt).rho);
    step(vz);
    if (alt < start.alt) alt = start.alt;
    points.push({ t, lat, lon, alt, phase });
  }
  const landing = { t, lat, lon, alt, ms: launchMs + t * 1000 };
  return {
    points, cutdown, landing, maxAlt: cutdown.alt, ascentS, totalS: t,
    distanceM: distanceM(start.lat, start.lon, landing.lat, landing.lon),
    bearing: bearingDeg(start.lat, start.lon, landing.lat, landing.lon),
  };
}

/** Plan value at a given flight time (for the Soll-Ist comparison during the ascent). */
export function planAt(result, tSec) {
  if (!result || !result.points.length) return null;
  const pts = result.points;
  if (tSec <= 0) return pts[0];
  if (tSec >= pts[pts.length - 1].t) return pts[pts.length - 1];
  let i = 1;
  while (pts[i].t < tSec) i++;
  const a = pts[i - 1], b = pts[i], f = (tSec - a.t) / (b.t - a.t);
  return { t: tSec, lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), alt: a.alt + f * (b.alt - a.alt), phase: a.phase };
}

// ---- airspace -------------------------------------------------------------------------------

/** Ray casting point-in-polygon; polygon = [[lat,lon],…]. */
export function pointInPolygon(lat, lon, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i], [yj, xj] = polygon[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * openAIP category table (type codes of api.core.openaip.net). `id` is what the admin setting
 * `airspaceCats` lists (default P,R,D,CTR,TMA). Same mapping as s2planning, so both apps agree.
 */
export const AIRSPACE_CATS = [
  { id: 'P', types: [3], color: '#c0392b' },
  { id: 'R', types: [1], color: '#d98c00' },
  { id: 'D', types: [2], color: '#d9a400' },
  { id: 'CTR', types: [4], color: '#1f5fbf' },
  { id: 'TMA', types: [7], color: '#7a9bd0' },
  { id: 'CTA', types: [26], color: '#93a3b5' },
  { id: 'TMZ', types: [5, 6], color: '#4f9d69' },
  { id: 'ATZ', types: [13], color: '#8c6bd6' },
  { id: 'GLD', types: [21], color: '#3fd06b' },
];

/** openAIP limit {value, unit (1 ft, 6 FL, else m), referenceDatum (0 GND/AGL, 1 MSL, 2 STD)} → m AMSL. */
export function openAipLimitM(lim, groundAlt) {
  if (!lim || lim.value === undefined || lim.value === null) return null;
  let m = lim.unit === 6 ? lim.value * 100 * 0.3048 : lim.unit === 1 ? lim.value * 0.3048 : lim.value;
  if (lim.referenceDatum === 0) m += groundAlt || 0;       // GND: approximated with the launch-site elevation
  return m;
}
export function openAipLimitText(lim) {
  if (!lim || lim.value === undefined || lim.value === null) return '?';
  if (lim.unit === 6) return `FL ${lim.value}`;
  if (lim.referenceDatum === 0 && lim.value === 0) return 'GND';
  return `${lim.value} ${lim.unit === 1 ? 'ft' : 'm'} ${lim.referenceDatum === 0 ? 'AGL' : lim.referenceDatum === 2 ? 'STD' : 'AMSL'}`;
}

/**
 * Convert openAIP items to the internal airspace shape {id, name, type, lowerM, upperM, lowerText,
 * upperText, polygon [[lat,lon],…], color}; one entry per polygon of a MultiPolygon. Only the
 * categories in `cats` (array of ids from AIRSPACE_CATS) are kept.
 */
export function fromOpenAip(items, groundAlt, cats = ['P', 'R', 'D', 'CTR', 'TMA']) {
  const byType = new Map();
  for (const c of AIRSPACE_CATS) if (cats.includes(c.id)) for (const t of c.types) byType.set(t, c);
  const out = [];
  for (const it of items || []) {
    const cat = byType.get(it.type);
    if (!cat || !it.geometry) continue;
    const polys = it.geometry.type === 'MultiPolygon' ? it.geometry.coordinates : [it.geometry.coordinates];
    polys.forEach((poly, i) => {
      if (!poly || !poly[0] || poly[0].length < 4) return;
      const lowerM = openAipLimitM(it.lowerLimit, groundAlt) ?? 0;
      const upperM = openAipLimitM(it.upperLimit, groundAlt) ?? 99999;
      out.push({ id: `${it._id || it.name}${polys.length > 1 ? `#${i + 1}` : ''}`, name: it.name || cat.id, type: cat.id, color: cat.color,
        lowerM, upperM, lowerText: openAipLimitText(it.lowerLimit), upperText: openAipLimitText(it.upperLimit),
        polygon: poly[0].map((pt) => [pt[1], pt[0]]) });
    });
  }
  return out;
}

/** Bounding box [w, s, e, n] of predicted points with a margin in degrees. */
export function bboxOf(points, pad = 0.15) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of points) { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); }
  return [w - pad, s - pad, e + pad, n + pad];
}

/**
 * First conflict per airspace along the predicted points.
 * Returns [{airspace, point, altEnter}] sorted by time; a conflict needs the point inside the
 * polygon AND between the vertical limits.
 */
export function airspaceConflicts(points, airspaces) {
  const out = [];
  for (const a of airspaces) {
    const hit = points.find((p) => p.alt >= a.lowerM && p.alt <= a.upperM && pointInPolygon(p.lat, p.lon, a.polygon));
    if (hit) out.push({ airspace: a, point: hit, altEnter: Math.max(a.lowerM, hit.alt) });
  }
  return out.sort((x, y) => x.point.t - y.point.t);
}

/**
 * Suggested cutdown altitude AGL (rounded down to 100 m) that keeps the flight below the lowest
 * conflicting airspace with a 100 m margin; null when the conflict starts at the ground.
 */
export function suggestCutdownAgl(conflicts, groundAlt) {
  if (!conflicts.length) return null;
  const lowest = Math.min(...conflicts.map((c) => c.airspace.lowerM));
  const agl = Math.floor((lowest - 100 - groundAlt) / 100) * 100;
  return agl >= 300 ? agl : null;
}
