// Flight files: <base>.raw_flight_history.csv (spec §7.2, byte-exact), <base>.sounding (§7.1)
// and <base>.kml (§7.4). The pure formatting functions are exported for the node tests; the
// FlightFiles class handles the File System Access API (Chrome/Edge: a Dropbox folder chosen once,
// handle persisted in IndexedDB) with a download fallback for other browsers / Android.

import { pad2 } from './util/format.js';

export const CSV_HEADER = 'UTC time, Altitude (m MSL), Altitude (m AGL), Pressure (Pascal), Speed (m/s), Heading (degrees), Temperature (C), Relative humidity (%), Internal temperature (C), Latitude, Longitude, Rise speed (m/s)';

const has = (v) => v !== null && v !== undefined && !Number.isNaN(v);
/** Python '%i' truncates toward zero. */
const pyInt = (v) => String(Math.trunc(v));
/** Python '%.2f' – toFixed is equivalent for the magnitudes used here; '-0.00' stays as Python prints it. */
const pyFixed = (v, d) => { const s = v.toFixed(d); return s; };

export function utcStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/**
 * One CSV row per spec §7.2, or null when the record must not be written
 * (needs alt and pressure and at least one of spd/ang/te/hu).
 */
export function csvRow(rec, groundAlt) {
  if (!has(rec.pa)) return null;
  if (!has(rec.alt)) return null;
  if (!(has(rec.spd) || has(rec.ang) || has(rec.te) || has(rec.hu))) return null;
  let s = utcStamp(rec.t);
  s += has(rec.alt) ? `, ${pyInt(rec.alt)}, ` : ',  , ';
  s += has(rec.alt) && has(groundAlt) ? `${pyInt(rec.alt - groundAlt)}, ` : ' , ';
  s += `${pyInt(rec.pa)}, `;
  for (const k of ['spd', 'ang', 'te', 'hu', 'tei']) s += has(rec[k]) ? `${pyFixed(rec[k], 2)}, ` : ' , ';
  s += has(rec.lat) && has(rec.lon) && !(rec.lat === 0 && rec.lon === 0) ? `${pyFixed(rec.lat, 6)}, ${pyFixed(rec.lon, 6)}, ` : ' ,  , ';
  if (has(rec.rise)) {
    const r = pyFixed(rec.rise, 1);
    s += r === '0.0' || r === '-0.0' ? '0' : r;
  }
  return s + '\n';
}

/** Whole CSV text: header + rows from the launch record on. */
export function csvText(records, groundAlt, launchIndex = 0) {
  let out = CSV_HEADER + '\n';
  for (let i = Math.max(0, launchIndex); i < records.length; i++) {
    const row = csvRow(records[i], groundAlt);
    if (row) out += row;
  }
  return out;
}

// ---- .sounding ------------------------------------------------------------------------------

/** "[-][hh h]mm m ss s mmm: " relative timestamp. */
export function soundingStamp(relMs) {
  const neg = relMs < 0; let ms = Math.abs(Math.round(relMs));
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  return `${neg ? '-' : ''}${h ? `${h}h` : ''}${pad2(m)}m${pad2(s)}s${String(ms).padStart(3, '0')}: `;
}

export function soundingHeader(meta) {
  const start = new Date(meta.startMs);
  const local = `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())} ${pad2(start.getHours())}:${pad2(start.getMinutes())}:${pad2(start.getSeconds())}`;
  const lines = [
    `# Session start ${local}`,
    `# offset=${(meta.startMs / 1000).toFixed(3)}`,
    `# timezone=${-start.getTimezoneOffset() * 60}`,
    '# version=4',
    `# receiver version=${meta.receiverAbout || 'Sparv RR4 hw=?, fw=?, prot=?'}`,
  ];
  if (meta.receiverMac) lines.push(`# receiver mac=${parseInt(meta.receiverMac, 16) || meta.receiverMac}`);
  lines.push(`# net_settings=${meta.net ? `${meta.net.timeslots}:${meta.net.slotMs}:${meta.net.sampleMs}` : '-'}`);
  lines.push('# install=s2ground wicki', `# software=S2Ground ${meta.version || '0.1'}`);
  if (meta.sondeId) lines.push(`# node_id=${meta.sondeId}`);
  return lines.join('\n') + '\n';
}

/** One sounding line; the id=<node_id> parameter is removed (per-sonde file convention). */
export function soundingLine(raw, relMs, sondeId) {
  let payload = raw;
  if (sondeId !== undefined && sondeId !== null && raw.startsWith('[#')) {
    // "[#TYPE:k=v,k=v[:data]]" → drop the "id=<n>" parameter, keep everything else byte for byte
    const m = /^(\[#[A-Z]+:)([^:\]]*)(.*)$/.exec(raw);
    if (m) payload = m[1] + m[2].split(',').filter((kv) => kv !== `id=${sondeId}`).join(',') + m[3];
  }
  return soundingStamp(relMs) + payload + '\n';
}

// ---- KML ------------------------------------------------------------------------------------

const kmlTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const xml = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

export function kmlText(records, meta) {
  const name = xml(meta.name || 'S2 Ground');
  const pts = records.filter((r) => has(r.lat) && has(r.lon) && has(r.alt));
  const coords = pts.map((r) => `${r.lon.toFixed(6)},${r.lat.toFixed(6)},${Math.round(r.alt)}`).join('\n');
  const first = pts[0], last = pts[pts.length - 1];
  let peak = null;
  for (const p of pts) if (!peak || p.alt > peak.alt) peak = p;
  const pm = (nm, style, p, mode = 'absolute') => p ? `<Placemark><name>${xml(nm)}</name><styleUrl>#${style}</styleUrl><TimeStamp><when>${kmlTime(p.t)}</when></TimeStamp><Point><altitudeMode>${mode}</altitudeMode><coordinates>${p.lon.toFixed(6)},${p.lat.toFixed(6)},${Math.round(p.alt)}</coordinates></Point></Placemark>` : '';
  const agl = (p) => (p && has(meta.groundAlt) ? `AGL ${Math.round(p.alt - meta.groundAlt)} m` : '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.1"><Document><name>${name}</name>
<Style id="now"><IconStyle><color>ffbf5f1f</color><scale>1.2</scale></IconStyle></Style>
<Style id="red_arrow"><IconStyle><color>ff2b39c0</color></IconStyle></Style>
<Style id="yellow_arrow"><IconStyle><color>ff3db0f6</color></IconStyle></Style>
<Style id="home"><IconStyle><color>ff4c8a1f</color></IconStyle></Style>
<Style id="top"><IconStyle><color>ff3db0f6</color></IconStyle></Style>
<Style id="track"><LineStyle><color>ffbf5f1f</color><width>3</width></LineStyle><PolyStyle><color>40bf5f1f</color></PolyStyle></Style>
${pm(`Launch ${meta.name || ''}`, 'home', first)}
<Placemark><name>Flight Path ${name}</name><styleUrl>#track</styleUrl><LineString><extrude>1</extrude><altitudeMode>absolute</altitudeMode><coordinates>
${coords}
</coordinates></LineString></Placemark>
${pm(`Peak (${agl(peak)})`, 'top', peak)}
${pm(`Location now (${agl(last)})`, 'now', last)}
${meta.landingEstimate ? pm('Landing estimate', 'red_arrow', { ...meta.landingEstimate, t: meta.landingEstimate.ms || Date.now() }, 'relativeToGround') : ''}
</Document></kml>
`;
}

// ---- storage --------------------------------------------------------------------------------

const IDB = 's2ground'; const STORE = 'handles';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  try { const db = await idb(); return await new Promise((res, rej) => { const tx = db.transaction(STORE).objectStore(STORE).get(key); tx.onsuccess = () => res(tx.result); tx.onerror = () => rej(tx.error); }); } catch { return null; }
}
async function idbSet(key, val) {
  try { const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).put(val, key); tx.onsuccess = res; tx.onerror = () => rej(tx.error); }); } catch { /* ignore */ }
}

export class FlightFiles {
  constructor() {
    this.supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
    this.dir = null; this.permission = 'prompt';
    this.records = []; this.lines = []; this.meta = null; this.launchIndex = 0; this.groundAlt = null;
    this.base = null; this.dirty = false; this.timer = null; this.flushMs = 5000;   // Dropbox syncs each write: do not rewrite every second
    this.written = { csv: 0 };
  }
  get folderName() { return this.dir ? this.dir.name : null; }

  /** Restore the persisted folder handle (permission may still need a user gesture). */
  async init() {
    if (!this.supported) return;
    const h = await idbGet('folder');
    if (h) { this.dir = h; try { this.permission = await h.queryPermission({ mode: 'readwrite' }); } catch { this.permission = 'prompt'; } }
  }
  async chooseFolder() {
    const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 's2ground' });
    this.dir = h; this.permission = 'granted'; await idbSet('folder', h);
    return h.name;
  }
  async ensurePermission() {
    if (!this.dir) return false;
    if (this.permission === 'granted') return true;
    try { this.permission = await this.dir.requestPermission({ mode: 'readwrite' }); } catch { /* not in a gesture */ }
    return this.permission === 'granted';
  }

  /** Start a new ascent: base name "YYYY-MM-DD_HHMM[_id]" (spec §7). */
  begin(meta) {
    const d = new Date(meta.startMs);
    this.base = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${meta.sondeId ? `_${meta.sondeId}` : ''}`;
    this.meta = meta; this.records = []; this.lines = [soundingHeader(meta)]; this.launchIndex = 0; this.groundAlt = meta.groundAlt ?? null;
    this.dirty = true;
  }
  // INF records are expanded from a MET line and carry that line as `raw`: write the line once (with the MET record), not per sample.
  addRecord(rec) { if (!this.meta) return; this.records.push(rec); if (rec.raw && rec.src !== 'INF') this.lines.push(soundingLine(rec.raw, rec.t - this.meta.startMs, this.meta.sondeId)); this._schedule(); }
  addComment(text, t = Date.now()) { if (!this.meta) return; this.lines.push(soundingLine(`# ${text}`, t - this.meta.startMs)); this._schedule(); }
  setLaunchIndex(i) { if (i !== this.launchIndex) { this.launchIndex = i; this._schedule(); } }
  setGroundAlt(a) { if (a !== this.groundAlt) { this.groundAlt = a; this._schedule(); } }

  csv() { return csvText(this.records, this.groundAlt, this.launchIndex); }
  sounding() { return this.lines.join(''); }
  kml(extra = {}) { return kmlText(this.records, { ...this.meta, groundAlt: this.groundAlt, ...extra }); }

  _schedule() { this.dirty = true; if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs); }

  /** Rewrite CSV + .sounding (small files; rewriting keeps them consistent after a launch re-detect). */
  async flush() {
    if (!this.dirty || !this.dir || this.permission !== 'granted' || !this.base) return false;
    this.dirty = false;
    try {
      if (this.groundAlt !== null) await this._write(`${this.base}.raw_flight_history.csv`, this.csv());
      await this._write(`${this.base}.sounding`, this.sounding());
      this.written.csv = this.records.length;
      return true;
    } catch (e) { console.warn('files: write failed', e); return false; }
  }
  async finish(extra = {}) {
    this.dirty = true; await this.flush();
    if (this.dir && this.permission === 'granted' && this.base) { try { await this._write(`${this.base}.kml`, this.kml(extra)); return true; } catch { return false; } }
    return false;
  }
  async _write(name, text) {
    const fh = await this.dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text); await w.close();
  }

  /** Fallback: offer the three files as downloads (Android, Firefox, no folder chosen). */
  downloadAll(extra = {}) {
    if (!this.base) return;
    const dl = (name, text, type) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    dl(`${this.base}.raw_flight_history.csv`, this.csv(), 'text/csv');
    dl(`${this.base}.sounding`, this.sounding(), 'text/plain');
    dl(`${this.base}.kml`, this.kml(extra), 'application/vnd.google-earth.kml+xml');
  }
}
