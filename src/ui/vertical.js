// Vertical view (SVG): altitude over distance from the start, with terrain, airspace boxes
// (horizontal extent = where the planned path is inside the polygon), planned profile (grey
// dashed) and actual profile (blue, pulsing dot at the sonde).

import { t } from '../i18n.js';
import { fmtInt, distanceM } from '../util/format.js';
import { pointInPolygon } from '../planning.js';
import { esc } from '../util/dom.js';

/**
 * @param {object} o plan (planning.predict result), records (TelemetryRecord[]), start {lat,lon,alt},
 *                   airspaces[], cutAltAmsl, w, h, big (font sizes)
 */
export function renderVertical(o) {
  const w = o.w || 440, h = o.h || 300, big = !!o.big;
  const L = 48, R = 10, T = big ? 30 : 36, B = 22;
  const start = o.start;
  const plan = o.plan ? o.plan.points.map((p) => ({ x: distanceM(start.lat, start.lon, p.lat, p.lon), y: p.alt })) : [];
  const act = (o.records || []).filter((r) => r.alt !== null && r.lat !== null).map((r) => ({ x: distanceM(start.lat, start.lon, r.lat, r.lon), y: r.alt }));
  const allY = [...plan.map((p) => p.y), ...act.map((p) => p.y), start.alt, o.cutAltAmsl || 0];
  const allX = [...plan.map((p) => p.x), ...act.map((p) => p.x), 1000];
  const maxAlt = Math.ceil((Math.max(...allY) + 400) / 500) * 500;
  const minAlt = Math.max(0, Math.floor((start.alt - 200) / 500) * 500);
  const maxX = Math.max(...allX) * 1.1;
  const sx = (x) => L + (x / maxX) * (w - L - R);
  const sy = (y) => T + ((maxAlt - y) / (maxAlt - minAlt)) * (h - T - B);
  const fs = big ? 12 : 10;
  let s = `<svg class="vert" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(t('vert.aria'))}">`;
  s += `<rect width="${w}" height="${h}" fill="#fbfcfd"/>`;
  // grid + labels
  const step = maxAlt - minAlt > 4000 ? 1000 : 500;
  for (let a = minAlt; a <= maxAlt; a += step) {
    s += `<line x1="${L}" y1="${sy(a)}" x2="${w - R}" y2="${sy(a)}" stroke="#eef1f5"/><text x="${L - 4}" y="${sy(a) + 4}" text-anchor="end" font-size="${fs}" fill="#5b6b7f">${fmtInt(a)}</text>`;
  }
  s += `<text x="12" y="${(T + h - B) / 2}" transform="rotate(-90 12 ${(T + h - B) / 2})" text-anchor="middle" font-size="${fs}" fill="#5b6b7f">m AMSL</text>`;
  const kmStep = maxX > 15000 ? 5000 : maxX > 6000 ? 2000 : 1000;
  for (let x = 0; x <= maxX; x += kmStep) s += `<text x="${sx(x)}" y="${h - 4}" text-anchor="middle" font-size="${fs}" fill="#5b6b7f">${x / 1000}${x === 0 || x + kmStep > maxX ? ' km' : ''}</text>`;
  // airspaces: where the plan path is inside the polygon
  for (const a of o.airspaces || []) {
    const inside = plan.filter((p, i) => pointInPolygon(o.plan.points[i].lat, o.plan.points[i].lon, a.polygon));
    if (!inside.length) continue;
    const x1 = Math.min(...inside.map((p) => p.x)), x2 = Math.max(...inside.map((p) => p.x));
    const y1 = sy(Math.min(a.upperM, maxAlt)), y2 = sy(Math.max(a.lowerM, minAlt));
    if (y2 <= y1) continue;
    s += `<rect x="${sx(x1)}" y="${y1}" width="${Math.max(4, sx(x2) - sx(x1))}" height="${y2 - y1}" fill="#c0392b" fill-opacity=".10" stroke="#c0392b" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    s += `<text x="${sx(x1) + 6}" y="${y1 + 14}" font-size="${fs + 1}" font-weight="600" fill="#7b1f14">${esc(a.name)} · ${esc(a.lowerText)} – ${esc(a.upperText)}</text>`;
  }
  // terrain (flat – TODO(planning): DEM profile along the track)
  const ty = sy(start.alt);
  s += `<path d="M${L} ${ty} L${w - R} ${ty - 6} L${w - R} ${h - B} L${L} ${h - B}Z" fill="#cdb995" stroke="#a88a5a" stroke-width="1"/>`;
  s += `<text x="${L + 8}" y="${Math.min(h - B - 4, ty + 14)}" font-size="${fs}" fill="#6b5634">${esc(t('vert.terrain'))}</text>`;
  // cutdown line
  if (o.cutAltAmsl) s += `<line x1="${L}" y1="${sy(o.cutAltAmsl)}" x2="${w - R}" y2="${sy(o.cutAltAmsl)}" stroke="#c0392b" stroke-width="1.5" stroke-dasharray="3 3"/><text x="${L + 4}" y="${sy(o.cutAltAmsl) - 4}" font-size="${fs}" fill="#c0392b">${esc(t('vert.cutdown'))} ${fmtInt(o.cutAltAmsl)} m AMSL</text>`;
  // plan + actual
  const pl = (pts) => pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  if (plan.length) s += `<polyline fill="none" stroke="#9aa7b6" stroke-width="2.5" stroke-dasharray="6 5" points="${pl(plan)}"/>`;
  if (act.length) {
    s += `<polyline fill="none" stroke="#1f5fbf" stroke-width="3" points="${pl(act)}"/>`;
    const last = act[act.length - 1];
    s += `<circle cx="${sx(last.x)}" cy="${sy(last.y)}" r="12" fill="#1f5fbf" fill-opacity=".25"><animate attributeName="r" values="8;16;8" dur="1.6s" repeatCount="indefinite"/><animate attributeName="fill-opacity" values=".35;.05;.35" dur="1.6s" repeatCount="indefinite"/></circle>`;
    s += `<circle cx="${sx(last.x)}" cy="${sy(last.y)}" r="6" fill="#1f5fbf" stroke="#fff" stroke-width="2"/>`;
    const right = sx(last.x) > w - 130;      // keep the label inside the plot near the right edge
    s += `<text x="${sx(last.x) + (right ? -12 : 12)}" y="${sy(last.y) - 6}" text-anchor="${right ? 'end' : 'start'}" font-size="${fs + 2}" font-weight="600" fill="#14202e">${fmtInt(last.y)} m AMSL</text>`;
  }
  // legend
  s += `<g font-size="${fs + 1}" fill="#5b6b7f"><line x1="${w - 140}" y1="${T - 14}" x2="${w - 110}" y2="${T - 14}" stroke="#9aa7b6" stroke-width="2.5" stroke-dasharray="6 5"/><text x="${w - 104}" y="${T - 10}">${esc(t('legend.plan'))}</text><line x1="${w - 70}" y1="${T - 14}" x2="${w - 40}" y2="${T - 14}" stroke="#1f5fbf" stroke-width="3"/><text x="${w - 34}" y="${T - 10}">${esc(t('legend.actual'))}</text></g>`;
  return s + '</svg>';
}
