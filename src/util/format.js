// Formatting and geodesy helpers. Pure functions, no DOM – shared by the UI, planning,
// files and the node tests. Swiss conventions: thousands separator ' (de-CH), units never wrap.

const NBSP = ' ';

/** 1910 → "1'910"; negative and float inputs are truncated to integers first. */
export function fmtInt(n, sep = "'") {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  const v = Math.round(n);
  const s = Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return (v < 0 ? '−' : '') + s;
}

/** Fixed decimals with typographic minus, e.g. fmtNum(-1.234, 1) → "−1.2". */
export function fmtNum(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  const s = Math.abs(n).toFixed(digits);
  return (n < 0 && Number(s) !== 0 ? '−' : '') + s;
}

/** Value + unit joined with a non-breaking space: "1'910 m". */
export function withUnit(valueStr, unit) { return `${valueStr}${NBSP}${unit}`; }

export const mToFt = (m) => m / 0.3048;
export const msToKt = (ms) => ms * 1.943844;
export const ktToMs = (kt) => kt / 1.943844;
export const pad2 = (n) => String(n).padStart(2, '0');

/** Wind *from* direction derived from the sonde's course over ground (the sonde drifts with the wind). */
export function windFromCourse(ang) {
  if (ang === null || ang === undefined) return null;
  return ((ang + 180) % 360 + 360) % 360;
}

/** Compass bearing "058°" with three digits. */
export function fmtBearing(deg) {
  if (deg === null || deg === undefined || Number.isNaN(deg)) return '–';
  return String(Math.round(((deg % 360) + 360) % 360) % 360).padStart(3, '0') + '°';
}

/** "12:34 min" from seconds. */
export function fmtDuration(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '–';
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}${NBSP}min`;
}

export function fmtTimeUTC(ms, withSeconds = false) {
  const d = new Date(ms);
  const base = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return withSeconds ? `${base}:${pad2(d.getUTCSeconds())}` : base;
}
export function fmtTimeLocal(ms, withSeconds = false) {
  const d = new Date(ms);
  const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad2(d.getSeconds())}` : base;
}
/** "2026-10-13" (local calendar date). */
export function fmtDateISO(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** "13.10.2026" */
export function fmtDateCH(ms) {
  const d = new Date(ms);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}
/** "13.10.2026 14:42:10" in UTC (activity log). */
export function fmtDateTimeUTC(ms) {
  const d = new Date(ms);
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${fmtTimeUTC(ms, true)}`;
}

// ---- ICAO coordinate formats --------------------------------------------------------------

/** 47.4433, 8.5617 → "4727N00834E" (degrees + rounded minutes). */
export function icaoShort(lat, lon) {
  if (lat === null || lon === null || lat === undefined || lon === undefined) return '–';
  const f = (v, degDigits) => {
    const a = Math.abs(v);
    let deg = Math.floor(a);
    let min = Math.round((a - deg) * 60);
    if (min === 60) { deg += 1; min = 0; }               // 47°59.6' rounds up to 48°00'
    return String(deg).padStart(degDigits, '0') + pad2(min);
  };
  return `${f(lat, 2)}${lat >= 0 ? 'N' : 'S'}${f(lon, 3)}${lon >= 0 ? 'E' : 'W'}`;
}

/** 47.4433, 8.5617 → "472636N0083342E" (degrees, minutes, seconds). */
export function icaoSeconds(lat, lon) {
  if (lat === null || lon === null || lat === undefined || lon === undefined) return '–';
  const f = (v, degDigits) => {
    const a = Math.abs(v);
    let total = Math.round(a * 3600);                     // whole seconds, rounding handled once
    const deg = Math.floor(total / 3600); total -= deg * 3600;
    const min = Math.floor(total / 60); const sec = total - min * 60;
    return String(deg).padStart(degDigits, '0') + pad2(min) + pad2(sec);
  };
  return `${f(lat, 2)}${lat >= 0 ? 'N' : 'S'}${f(lon, 3)}${lon >= 0 ? 'E' : 'W'}`;
}

/** Parse "4727N00834E" or "472636N0083342E" back to {lat, lon}; null when it does not match. */
export function parseIcao(s) {
  const m = /^(\d{2})(\d{2})(\d{2})?([NS])(\d{3})(\d{2})(\d{2})?([EW])$/.exec((s || '').trim().toUpperCase());
  if (!m) return null;
  const lat = (+m[1] + (+m[2]) / 60 + (+(m[3] || 0)) / 3600) * (m[4] === 'S' ? -1 : 1);
  const lon = (+m[5] + (+m[6]) / 60 + (+(m[7] || 0)) / 3600) * (m[8] === 'W' ? -1 : 1);
  return { lat, lon };
}

// ---- altitude / pressure (ISA) -----------------------------------------------------------

/** ISA pressure altitude in m from pressure in Pa. */
export function isaAltitude(pa) { return 44330 * (1 - Math.pow(pa / 101325, 0.190263)); }
/** ISA pressure in Pa at altitude m. */
export function isaPressure(altM) { return 101325 * Math.pow(1 - altM / 44330, 5.25588); }
/**
 * Pressure altitude AMSL referenced to the ground: the sonde's ISA altitude is shifted so that
 * the ground pressure maps to the known ground altitude (this removes the QNH error).
 */
export function altFromPressure(pa, groundPa, groundAlt) {
  if (pa === null || pa === undefined) return null;
  if (!groundPa || groundAlt === null || groundAlt === undefined) return isaAltitude(pa);
  return groundAlt + (isaAltitude(pa) - isaAltitude(groundPa));
}
/** QNH in hPa from station pressure and station altitude (ISA reduction). */
export function qnhFromStation(paPa, altM) {
  return 1013.25 * Math.pow(paPa / 100 / 1013.25, 1) / Math.pow(1 - altM / 44330, 5.25588);
}
/** Magnus formula dew point in °C. */
export function dewPoint(tC, rh) {
  if (tC === null || rh === null || tC === undefined || rh === undefined || rh <= 0) return null;
  const a = 17.62, b = 243.12;
  const g = Math.log(rh / 100) + (a * tC) / (b + tC);
  return (b * g) / (a - g);
}

// ---- geodesy (spherical earth is plenty for a 20 km sonde flight) ------------------------

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
/** Destination point from start, bearing (°) and distance (m). */
export function destPoint(lat, lon, brg, distM) {
  const d = distM / R, b = rad(brg), p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: deg(p2), lon: ((deg(l2) + 540) % 360) - 180 };
}

/** Google Maps driving navigation deep link (works on phones via QR as well). */
export function googleMapsNavUrl(lat, lon) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=driving`;
}
