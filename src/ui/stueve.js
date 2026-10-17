// Simplified live Stüve diagram (SVG), styled like design/Follow.dc.html:
// x linear in temperature, y linear in p^0.286 (so dry adiabats are straight lines),
// isobars with hPa + "≈ m AMSL" stacked labels, moist adiabats (pseudo-adiabatic integration),
// T red, Td blue, cloud band where RH > threshold, wind barbs per isobar on the right.

import { t } from '../i18n.js';
import { fmtInt, altFromPressure, msToKt, windFromCourse, fmtBearing } from '../util/format.js';
import { esc } from '../util/dom.js';

const KAPPA = 0.286;
const Rd = 287.05, cp = 1004, Lv = 2.5e6, EPS = 0.622;
const es = (TK) => 611.2 * Math.exp((17.67 * (TK - 273.15)) / (TK - 29.65));

/** Pseudo-adiabat from (T0 °C at pBottom) up to pTop, step 5 hPa; returns [[p, T°C], …]. */
function moistAdiabat(T0c, pBottom, pTop) {
  const pts = []; let T = T0c + 273.15;
  for (let p = pBottom; p >= pTop; p -= 5) {
    pts.push([p, T - 273.15]);
    const pa = p * 100, e = es(T), rs = (EPS * e) / (pa - e);
    const dTdp = ((Rd * T + Lv * rs) / (cp + (Lv * Lv * rs * EPS) / (Rd * T * T))) / pa;
    T -= dTdp * 500;                                     // dp = −5 hPa
  }
  return pts;
}

/** Standard wind barb as SVG at (cx, cy) for direction (from) and speed in kt. */
function barb(cx, cy, dirDeg, kt, color = '#14202e') {
  if (kt < 2.5) return `<circle cx="${cx}" cy="${cy}" r="4" fill="none" stroke="${color}" stroke-width="1.4"/>`;
  const len = 24; let s = `<g transform="rotate(${dirDeg.toFixed(0)} ${cx} ${cy})" stroke="${color}" stroke-width="1.4" fill="none" stroke-linecap="round">`;
  s += `<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - len}"/>`;
  let rem = Math.round(kt / 5) * 5, y = cy - len;
  const flag = () => { s += `<polygon points="${cx},${y} ${cx + 9},${y + 3} ${cx},${y + 6}" fill="${color}" stroke="none"/>`; y += 7; };
  const long = () => { s += `<line x1="${cx}" y1="${y}" x2="${cx + 10}" y2="${y - 4}"/>`; y += 5; };
  const short = () => { if (y === cy - len) y += 5; s += `<line x1="${cx}" y1="${y}" x2="${cx + 5}" y2="${y - 2}"/>`; y += 5; };
  while (rem >= 50) { flag(); rem -= 50; }
  while (rem >= 10) { long(); rem -= 10; }
  if (rem >= 5) short();
  return s + '</g>';
}

/**
 * @param {object} o records (TelemetryRecord[]), groundPa, groundAlt, cloudRh (%), w, h,
 *                   compact (true for the small live viewer)
 * @returns {{svg:string, derived:object}}
 */
export function renderStueve(o) {
  const recs = (o.records || []).filter((r) => r.pa !== null && r.te !== null);
  const w = o.w || 760, h = o.h || 520;
  const L = 64, R = 160, T = 46, B = 68;
  const pw = w - L - R, ph = h - T - B;
  const pBottom = 1000;
  const minP = recs.length ? Math.min(...recs.map((r) => r.pa)) / 100 : 800;
  const pTop = minP < 520 ? 300 : minP < 720 ? 500 : 500;
  const tMin = -40, tMax = 30;
  const f = (p) => Math.pow(p, KAPPA);
  const sy = (p) => T + ((f(pBottom) - f(p)) / (f(pBottom) - f(pTop))) * ph;
  const sx = (tc) => L + ((tc - tMin) / (tMax - tMin)) * pw;
  const clipY = (y) => Math.max(T, Math.min(T + ph, y));
  const fs = o.compact ? 10 : 11;
  const alt = (p) => altFromPressure(p * 100, o.groundPa, o.groundAlt);

  let s = `<svg class="stueve" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(t('stueve.aria'))}">`;
  s += `<defs><clipPath id="stplot"><rect x="${L}" y="${T}" width="${pw}" height="${ph}"/></clipPath></defs>`;
  s += `<rect x="${L}" y="${T}" width="${pw}" height="${ph}" fill="#fbfcfd" stroke="#c7d0dc"/>`;
  // cloud band(s): contiguous records with RH > threshold
  const thr = o.cloudRh || 92;
  let band = null; const bands = [];
  for (const r of recs) {
    if (r.hu !== null && r.hu >= thr) { if (!band) band = { pMax: r.pa, pMin: r.pa, alt: r.alt }; band.pMax = Math.max(band.pMax, r.pa); band.pMin = Math.min(band.pMin, r.pa); }
    else if (band) { bands.push(band); band = null; }
  }
  if (band) bands.push(band);
  for (const b of bands) s += `<rect x="${L}" y="${clipY(sy(b.pMin / 100))}" width="${pw}" height="${Math.max(2, clipY(sy(b.pMax / 100)) - clipY(sy(b.pMin / 100)))}" fill="#9aa7b6" fill-opacity=".3"/>`;
  // dry adiabats (straight lines): T = θ·(p/1000)^κ
  s += `<g clip-path="url(#stplot)" stroke="#d2b48c" stroke-width="1" fill="none">`;
  for (let th = -30; th <= 150; th += 10) {
    const tb = (th + 273.15) * Math.pow(pBottom / 1000, KAPPA) - 273.15, tt = (th + 273.15) * Math.pow(pTop / 1000, KAPPA) - 273.15;
    s += `<line x1="${sx(tb).toFixed(1)}" y1="${sy(pBottom)}" x2="${sx(tt).toFixed(1)}" y2="${sy(pTop)}"/>`;
  }
  s += '</g>';
  // moist adiabats
  s += `<g clip-path="url(#stplot)" stroke="#4f9d69" stroke-width="1" stroke-dasharray="4 4" fill="none">`;
  for (let t0 = -20; t0 <= 40; t0 += 6) s += `<polyline points="${moistAdiabat(t0, pBottom, pTop).map(([p, tc]) => `${sx(tc).toFixed(1)},${sy(p).toFixed(1)}`).join(' ')}"/>`;
  s += '</g>';
  // isotherms
  s += '<g stroke="#e6eaf0" stroke-width="1">';
  for (let tc = tMin; tc <= tMax; tc += 10) s += `<line x1="${sx(tc)}" y1="${T}" x2="${sx(tc)}" y2="${T + ph}"${tc === 0 ? ' stroke="#9aa7b6"' : ''}/>`;
  s += '</g>';
  // isobars + labels
  const isobars = [1000, 950, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300].filter((p) => p >= pTop);
  s += '<g stroke="#dfe4ea" stroke-width="1">';
  for (const p of isobars) s += `<line x1="${L}" y1="${sy(p).toFixed(1)}" x2="${L + pw}" y2="${sy(p).toFixed(1)}"${p % 100 === 0 ? ' stroke="#b8c2d0"' : ''}/>`;
  s += '</g>';
  s += `<g fill="#5b6b7f" font-size="${fs}" font-family="IBM Plex Mono, ui-monospace, monospace">`;
  for (const p of isobars) {
    if (o.compact && p % 100 !== 0) continue;                  // compact: 1000/900/800/… only (design board)
    s += `<text x="${L - 6}" y="${(sy(p) - 1).toFixed(1)}" text-anchor="end" font-weight="600" fill="#14202e">${p}</text><text x="${L - 6}" y="${(sy(p) + 11).toFixed(1)}" text-anchor="end">≈ ${fmtInt(alt(p))}</text>`;
  }
  s += `<text x="${L - 6}" y="22" text-anchor="end" font-size="10" font-weight="600" fill="#14202e">hPa</text><text x="${L - 6}" y="34" text-anchor="end" font-size="10">m AMSL</text>`;
  for (let tc = tMin; tc <= tMax; tc += 10) s += `<text x="${sx(tc)}" y="${T + ph + 16}" text-anchor="middle">${tc < 0 ? '−' + Math.abs(tc) : tc}${tc === tMax ? ' °C' : ''}</text>`;
  s += '</g>';
  // curves (decimated to ~2 hPa bins)
  const bins = new Map();
  for (const r of recs) { const k = Math.round(r.pa / 200); if (!bins.has(k)) bins.set(k, r); }
  const curve = [...bins.values()].sort((a, b) => b.pa - a.pa);
  const pts = (key) => curve.filter((r) => r[key] !== null).map((r) => `${sx(r[key]).toFixed(1)},${sy(r.pa / 100).toFixed(1)}`).join(' ');
  s += '<g clip-path="url(#stplot)">';
  if (curve.length) s += `<polyline fill="none" stroke="#c0392b" stroke-width="2.6" stroke-linejoin="round" points="${pts('te')}"/><polyline fill="none" stroke="#1f5fbf" stroke-width="2.6" stroke-linejoin="round" points="${pts('td')}"/>`;
  s += '</g>';
  const last = recs[recs.length - 1];
  if (last) {
    const cx = sx(last.te), cy = clipY(sy(last.pa / 100));
    s += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="10" fill="#1f5fbf" fill-opacity=".25"><animate attributeName="r" values="7;14;7" dur="1.6s" repeatCount="indefinite"/><animate attributeName="fill-opacity" values=".35;.05;.35" dur="1.6s" repeatCount="indefinite"/></circle>`;
    s += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5.5" fill="#f6b03d" stroke="#14202e" stroke-width="1.2"/>`;
    s += `<text x="${(cx + 10).toFixed(1)}" y="${(cy - 6).toFixed(1)}" fill="#14202e" font-size="${fs + 1}" font-weight="600">${esc(t('stueve.now'))} · ${fmtInt(last.alt)} m AMSL · ${Math.round(last.pa / 100)} hPa</text>`;
    const first = recs[0];
    // ground label below-right of the first point; skipped while the sonde is still next to it
    if (Math.abs(clipY(sy(first.pa / 100)) - cy) > 18) s += `<text x="${(sx(first.te) + 8).toFixed(1)}" y="${(clipY(sy(first.pa / 100)) + 14).toFixed(1)}" fill="#5b6b7f" font-size="${fs}">${esc(t('stueve.ground'))} ${fmtInt(o.groundAlt)} m · ${Math.round((o.groundPa || first.pa) / 100)} hPa</text>`;
  }
  // wind column
  const wx = L + pw + 60;
  s += `<line x1="${wx}" y1="${T}" x2="${wx}" y2="${T + ph}" stroke="#e6eaf0"/>`;
  s += `<text x="${wx}" y="22" text-anchor="middle" font-weight="600" font-size="10" fill="#14202e">${esc(t('stueve.wind'))}</text><text x="${wx}" y="34" text-anchor="middle" font-size="10" fill="#5b6b7f">kt</text>`;
  const winds = [];
  for (const p of isobars.concat([Math.round((o.groundPa || 96000) / 100)])) {
    const near = recs.filter((r) => r.spd !== null && Math.abs(r.pa / 100 - p) < 10);
    if (!near.length) continue;
    const r = near.reduce((a, b) => (Math.abs(a.pa / 100 - p) < Math.abs(b.pa / 100 - p) ? a : b));
    const dir = windFromCourse(r.ang), kt = msToKt(r.spd), y = clipY(sy(r.pa / 100));
    if (winds.some((x) => Math.abs(x.y - y) < 14)) continue;
    winds.push({ p, dir, kt, y, alt: r.alt });
    s += `<circle cx="${wx}" cy="${y.toFixed(1)}" r="2.2" fill="#14202e"/>${barb(wx, y, dir, kt)}`;
    s += `<text x="${wx + 36}" y="${(y + 4).toFixed(1)}" font-size="10" fill="#5b6b7f" font-family="IBM Plex Mono, ui-monospace, monospace">${fmtBearing(dir)}/${String(Math.round(kt)).padStart(2, '0')}</text>`;
  }
  // legend
  if (!o.compact) {
    const ly = h - 14;
    s += `<g font-size="11" fill="#5b6b7f"><line x1="${L}" y1="${ly}" x2="${L + 22}" y2="${ly}" stroke="#c0392b" stroke-width="2.6"/><text x="${L + 28}" y="${ly + 4}">${esc(t('stueve.temp'))}</text>`;
    s += `<line x1="${L + 110}" y1="${ly}" x2="${L + 132}" y2="${ly}" stroke="#1f5fbf" stroke-width="2.6"/><text x="${L + 138}" y="${ly + 4}">${esc(t('stueve.dew'))}</text>`;
    s += `<line x1="${L + 210}" y1="${ly}" x2="${L + 232}" y2="${ly}" stroke="#d2b48c" stroke-width="1"/><text x="${L + 238}" y="${ly + 4}">${esc(t('stueve.dry'))}</text>`;
    s += `<line x1="${L + 350}" y1="${ly}" x2="${L + 372}" y2="${ly}" stroke="#4f9d69" stroke-width="1" stroke-dasharray="4 4"/><text x="${L + 378}" y="${ly + 4}">${esc(t('stueve.moist'))}</text>`;
    s += `<rect x="${L + 480}" y="${ly - 7}" width="22" height="9" fill="#9aa7b6" fill-opacity=".3"/><text x="${L + 508}" y="${ly + 4}">${esc(t('stueve.cloud'))} (RH &gt; ${thr} %)</text></g>`;
  } else {
    s += `<g font-size="11" fill="#5b6b7f"><line x1="${L + 8}" y1="${T - 8}" x2="${L + 30}" y2="${T - 8}" stroke="#c0392b" stroke-width="2.5"/><text x="${L + 34}" y="${T - 4}">T</text><line x1="${L + 56}" y1="${T - 8}" x2="${L + 78}" y2="${T - 8}" stroke="#1f5fbf" stroke-width="2.5"/><text x="${L + 82}" y="${T - 4}">Td</text><rect x="${L + 108}" y="${T - 14}" width="14" height="12" fill="#9aa7b6" fill-opacity=".4"/><text x="${L + 126}" y="${T - 4}">RH &gt; ${thr} %</text></g>`;
  }
  s += '</svg>';
  return { svg: s, derived: derive(recs, winds, thr) };
}

/** Automatically detected features for the side panel. */
function derive(recs, winds, thr) {
  const d = { inversion: null, cloudBase: null, zeroLevel: null, wind850: null };
  const up = recs.filter((r) => r.alt !== null);
  // 50 m altitude bins (mean T) so 1 Hz noise does not fake an inversion
  const bins = new Map();
  for (const r of up) { const k = Math.floor(r.alt / 50); const b = bins.get(k) || { alt: k * 50 + 25, sum: 0, n: 0 }; b.sum += r.te; b.n++; bins.set(k, b); }
  const prof = [...bins.values()].sort((a, b) => a.alt - b.alt).map((b) => ({ alt: b.alt, te: b.sum / b.n }));
  let invStart = null;
  for (let i = 1; i < prof.length; i++) {
    const a = prof[i - 1], b = prof[i];
    if (b.te > a.te + 0.05) { if (invStart === null) invStart = a.alt; d.inversion = [invStart, b.alt]; }
    else invStart = null;
    if (d.zeroLevel === null && a.te > 0 && b.te <= 0) d.zeroLevel = b.alt;
  }
  const cb = up.find((r) => r.hu !== null && r.hu >= thr);
  if (cb) d.cloudBase = cb.alt;
  const w850 = winds.find((w) => w.p === 850);
  if (w850) d.wind850 = w850;
  return d;
}
