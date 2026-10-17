// Line classification (spec §1.2) and bracket-line parsing with typed conversions (spec §5.10).
// Pure functions. The receiver interleaves two protocols on one serial line, so every received
// line is first classified here; `parseBracketLine` turns `[#TYPE:k=v,…:data]` and `[response]`
// into objects the rest of the layer (text queue, telemetry) can consume without re-parsing.

/**
 * @typedef {{kind:'ssp'|'message'|'response'|'log'|'unknown', hex?:string, bracket?:string, raw:string}} ClassifiedLine
 */

/** Strip leading '>' prompt characters, NUL bytes and whitespace (spec §1.2). */
export function cleanLine(raw) {
  return String(raw).replace(/\0/g, '').replace(/^[\s>]+/, '').replace(/\s+$/, '');
}

/** @returns {ClassifiedLine} */
export function classifyLine(raw) {
  const s = cleanLine(raw);
  // SSP hex frame; tolerated spellings 'x…' and '00x…' (spec §1.2)
  const m = /^(?:0x|00x|x)([0-9a-fA-F]*)(.*)$/.exec(s);
  if (m && (s.startsWith('0x') || s.startsWith('00x') || s.startsWith('x'))) {
    if (m[2].trim() === '' && m[1].length % 2 === 0) return { kind: 'ssp', hex: '0x' + m[1].toLowerCase(), raw };
    return { kind: 'unknown', raw };
  }
  // device log lines look like "[…][X][…]…" and are ignored
  if (/^\[[^\]]*\]\[[A-Za-z]\]\[/.test(s)) return { kind: 'log', raw };
  const br = extractBracket(s);
  if (br === null) return { kind: 'unknown', raw };
  return { kind: br.startsWith('[#') ? 'message' : 'response', bracket: br, raw };
}

/** First '[' … matching ']' of a line (junk before/after is ignored, spec §1.2); null when absent. */
export function extractBracket(s) {
  const a = s.indexOf('[');
  if (a < 0) return null;
  let depth = 0;
  for (let i = a; i < s.length; i++) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']') { depth--; if (depth === 0) return s.slice(a, i + 1); }
  }
  return null;
}

// ---- typed conversions (spec §5.10) ---------------------------------------------------------------
const FLOAT_KEYS = new Set(['lat', 'lon', 'alt', 'te', 'tei', 'tmp2', 'hu', 'spd', 'ang', 'su', 'rise']);
const HEX_KEYS = new Set(['q', 'q0', 'q1']);
const STRING_KEYS = new Set(['crc', 'md', 'seq']);
/** °C values above 400 wrap (the sonde sends an unsigned 16-bit hundredth): te − 655.36 */
export const unwrapTemp = (v) => (v === null ? null : v > 400 ? +(v - 655.36).toFixed(2) : v);
/** `ang1…5` history: negative values + 327.68 (signed 16-bit hundredth wrap) */
const unwrapAng = (v) => (v === null ? null : v < 0 ? +(v + 327.68).toFixed(2) : v);

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * Convert one key/value pair of a bracket message to its typed form.
 * Returns the (possibly renamed) key and value; `null` value = unusable.
 */
export function convertParam(key, value) {
  if (HEX_KEYS.has(key)) { const n = parseInt(value, 16); return [key, Number.isFinite(n) ? n : null]; }
  if (key === 'md') return ['md', /^\d+$/.test(value) ? Number(value) : value === 'A' ? 'A' : value];
  if (key === 'seq') return ['seq', /^-?\d+$/.test(value) ? Number(value) : value];
  if (STRING_KEYS.has(key)) return [key, value];
  if (/^te\d*$/.test(key)) return [key, unwrapTemp(num(value))];
  if (key === 'tei') { const n = num(value); return [key, n === null || Math.abs(n - 64) < 1e-9 ? null : n]; }
  if (/^ang\d+$/.test(key)) return [key, unwrapAng(num(value))];
  if (key === 'ang') return [key, unwrapAng(num(value))];
  if (FLOAT_KEYS.has(key) || /^(spd|hu)\d+$/.test(key)) return [key, num(value)];
  if (/^-?\d+$/.test(value)) return [key, Number(value)];
  if (/^-?\d*\.\d+$/.test(value)) return [key, num(value)];
  return [key, value];
}

/**
 * Normalised link quality 0..1 from the params of a DAT/MET/PK message (spec §5.10).
 * RR4 "precise RSSI": clamp((rs+snr+140)/90); else q (hex byte, max of q0/q1) or r → /256.
 */
export function rssiFromParams(p) {
  if (p.rs !== undefined && p.rs !== null) { const snr = p.snr ?? 0; return Math.max(0, Math.min(1, (p.rs + snr + 140) / 90)); }
  let q = null;
  if (p.q0 !== undefined || p.q1 !== undefined) q = Math.max(p.q0 ?? 0, p.q1 ?? 0);
  else if (p.q !== undefined && p.q !== null) q = p.q;
  else if (p.r !== undefined && p.r !== null) q = p.r;
  return q === null ? null : Math.max(0, Math.min(1, q / 256));
}

/**
 * Parse a bracket line (message `[#TYPE:k=v,…:data]` or response `[text]`).
 * @returns {{isMessage:boolean, type:string|null, params:object, data:string, text:string, raw:string, id:number|null, role:number|null}|null}
 *   `params` holds the typed values; the raw strings stay available in `rawParams`.
 */
export function parseBracketLine(raw) {
  const br = extractBracket(cleanLine(raw));
  if (!br) return null;
  const inner = br.slice(1, -1);
  if (!inner.startsWith('#')) return { isMessage: false, type: null, params: {}, rawParams: {}, data: '', text: inner, raw: String(raw), id: null, role: null };
  // exactly up to three colon-separated parts: TYPE, params, free data (data may contain ':')
  const c1 = inner.indexOf(':');
  const type = (c1 < 0 ? inner.slice(1) : inner.slice(1, c1)).trim();
  let paramStr = '', data = '';
  if (c1 >= 0) {
    const rest = inner.slice(c1 + 1);
    const c2 = rest.indexOf(':');
    if (c2 < 0) paramStr = rest; else { paramStr = rest.slice(0, c2); data = rest.slice(c2 + 1); }
  }
  const params = {}, rawParams = {};
  for (const kv of paramStr.split(',')) {
    if (!kv.trim()) continue;
    const eq = kv.indexOf('=');
    const k = (eq < 0 ? kv : kv.slice(0, eq)).trim(), v = eq < 0 ? '' : kv.slice(eq + 1).trim();
    rawParams[k] = v;
    const [key, val] = convertParam(k, v);
    params[key] = val;
  }
  // `q` = max(q0, q1) when both present (spec §5.10)
  if (params.q0 !== undefined || params.q1 !== undefined) params.q = Math.max(params.q0 ?? 0, params.q1 ?? 0);
  if (params.new === undefined && type === 'DAT') params.new = 1;      // absent = treated as new fix
  return { isMessage: true, type, params, rawParams, data, text: inner, raw: String(raw), id: params.id ?? null, role: params.role ?? null };
}

/**
 * Decode the data part of a TXT message: `X(letters+numbers)` → {kind:'C'|'R'|'w'|…, map:{letter:int}}.
 * e.g. "R(S57B411C0L1)" → {kind:'R', map:{S:57, B:411, C:0, L:1}}; null when it does not match.
 */
export function parseTxtData(data) {
  const m = /^\s*([A-Za-z])\((.*)\)\s*$/.exec(data || '');
  if (!m) return null;
  const map = {};
  for (const x of m[2].matchAll(/([A-Za-z])(-?\d+)/g)) map[x[1]] = Number(x[2]);
  return { kind: m[1], map, inner: m[2] };
}

/** Parse the `about` reply: `about="Sparv RR4 hw=4, fw=1.4.2, prot=6"` → {product, hw, fw, prot} (spec §5.1, Q6). */
export function parseAbout(text) {
  const s = String(text || '').replace(/^about=/, '').replace(/^"|"$/g, '').replace(/\n/g, ' ');
  const get = (k) => { const m = new RegExp(`${k}\\s*=\\s*([^,\\s"]+)`).exec(s); return m ? m[1] : null; };
  const prot = get('prot');
  return { product: s.split(/\s+hw=|,/)[0].trim(), hw: get('hw'), fw: get('fw'), prot: prot === null ? null : Number(prot), raw: s };
}
