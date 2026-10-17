// WhatsApp notification of observers about a new sonde ascent – two stages:
//   Stage 1 (works today, no accounts): the Worker only BUILDS the standard message and a
//     wa.me link (https://wa.me/<digits>?text=…); the ground user taps the button in the
//     Prepare page and WhatsApp on the laptop/phone opens with the text prefilled.
//   Stage 2 (prepared, not yet released): sendWhatsApp() posts the same text through the Meta
//     WhatsApp Cloud API when the settings waPhoneNumberId + waToken are set. Outside a 24 h
//     conversation window Meta only accepts pre-approved TEMPLATE messages, so plain text will
//     be rejected until a template exists – see README, "WhatsApp".
// The message is built here (not in the browser) so s2stueve, the admin page and a future
// scheduled job all produce exactly the same text.

const GRAPH = 'https://graph.facebook.com/v21.0';
export const FOLLOW_URL = 'https://s2stueve.wicki.aero';

/** ICAO short form "4727N00834E" (same rule as src/util/format.js icaoShort; copied so the Worker has no browser imports). */
export function icaoShort(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  const f = (v, degDigits) => {
    const a = Math.abs(v);
    let deg = Math.floor(a);
    let min = Math.round((a - deg) * 60);
    if (min === 60) { deg += 1; min = 0; }
    return String(deg).padStart(degDigits, '0') + String(min).padStart(2, '0');
  };
  return `${f(lat, 2)}${lat >= 0 ? 'N' : 'S'}${f(lon, 3)}${lon >= 0 ? 'E' : 'W'}`;
}
/** Local time (Europe/Zurich) as "17.10.2026 14:30 LT" – observers are in Switzerland, UTC would confuse them. */
export function fmtLocal(ms, tz = 'Europe/Zurich') {
  if (!Number.isFinite(ms)) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('de-CH', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute} LT`;
}
const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "'");

/**
 * Standard message (DE) from the ascent meta {plannedLaunch, start:{name,lat,lon}, cutAltAgl, frequencyHz, sondeId}
 * and the observer's code. Lines with unknown values are left out rather than shown as "–".
 */
export function buildNotifyMessage(meta = {}, code = '') {
  const s = meta.start || {};
  const lines = ['Sondenaufstieg geplant (S2 Ground)'];
  const when = fmtLocal(Number(meta.plannedLaunch));
  if (when) lines.push(`Start: ${when}`);
  const coords = icaoShort(Number(s.lat), Number(s.lon));
  if (s.name || coords) lines.push(`Startort: ${[s.name, coords].filter(Boolean).join(' · ')}`);
  if (Number.isFinite(Number(meta.cutAltAgl)) && meta.cutAltAgl !== null) lines.push(`Cutdown: ${thousands(meta.cutAltAgl)} m AGL`);
  if (Number(meta.frequencyHz) > 0) lines.push(`Frequenz: ${(Number(meta.frequencyHz) / 1e6).toFixed(3)} MHz`);
  if (meta.sondeId) lines.push(`Sonde: ${meta.sondeId}`);
  lines.push(`Folgen: ${FOLLOW_URL} → Follow sonde ascent · Dein Code: ${code}`);
  return lines.join('\n');
}

/** Digits only for wa.me ("+41 79 123 45 67" → "41791234567"); '' when nothing usable. */
export function waDigits(mobile) {
  const d = String(mobile || '').replace(/\D/g, '');
  return d.length >= 8 ? d : '';
}
export function waUrl(mobile, text) {
  const d = waDigits(mobile);
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

/** Stage 2: true when the Cloud API credentials are stored. */
export function waConfigured(settings) {
  return !!(settings && settings.waPhoneNumberId && settings.waToken);
}

/**
 * Stage 2: send `text` to `to` (E.164 or digits) through the Meta WhatsApp Cloud API.
 * Returns {ok, status, error}. Never throws – a failed notification must not block the ascent.
 */
export async function sendWhatsApp(env, settings, to, text) {
  if (!waConfigured(settings)) return { ok: false, status: 0, error: 'E_WA_NOT_CONFIGURED' };
  const digits = waDigits(to);
  if (!digits) return { ok: false, status: 0, error: 'E_WA_BAD_NUMBER' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(`${GRAPH}/${encodeURIComponent(settings.waPhoneNumberId)}/messages`, {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${settings.waToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: digits, type: 'text', text: { body: text, preview_url: false } }),
    });
    if (res.ok) return { ok: true, status: res.status, error: null };
    const err = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, error: (err.error && err.error.message) || `E_WA_${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, error: 'E_WA_UNREACHABLE' };
  } finally { clearTimeout(timer); }
}
