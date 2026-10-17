// Ground users + app settings (D1). Master-only writes; every change is written to the activity log.
// Users have no roles any more – only the flag `master` (Superuser). Observers live in observers.js.

import { hashPassword, verifyPassword, requireRole, HttpError } from './auth.js';
import { logAction } from './log.js';

const NAME_RE = /^[a-z0-9_.-]{2,32}$/;

export const DEFAULT_SETTINGS = {
  relayUrl: '', frequencyHz: 433900000, riseRate: 2.5, descentRate: 5.0, cloudRh: 92,
  defaultFolder: '…\\Dropbox\\S2 Ground\\Aufstiege\\', autoLogoutH: 2, rr4Usb: '', sondeTypes: 'S2H3-R-B20 · S2H3-S-C1-B9',
  quickRepliesGround: ['Verstanden', 'Ausgelöst ✓', 'Funk schwach', 'Gelandet'],
  quickRepliesObserver: ['Bitte jetzt auslösen', 'Weiter steigen lassen', 'Daten reichen'],
  windFallbackDir: 240, windFallbackSpd: 6,
  cutAltAgl: 3000,                       // planning default, m AGL
  openaipKey: '',                        // openAIP core API key – server-side only, never sent to clients
  airspaceCats: 'P,R,D,CTR,TMA',         // openAIP categories that count as a conflict
  waPhoneNumberId: '',                   // Meta WhatsApp Cloud API: phone number id (stage 2, see whatsapp.js)
  waToken: '',                           // Meta WhatsApp Cloud API: permanent access token (secret)
};
/** Keys that must never leave the Worker (returned masked as '' / 'set'). */
const SECRET_KEYS = ['openaipKey', 'waToken', 'waPhoneNumberId'];
export function publicSettings(s) {
  const out = { ...s };
  for (const k of SECRET_KEYS) out[k] = s[k] ? 'set' : '';
  return out;
}

export async function getSettings(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'app'").first();
  let stored = {};
  try { stored = row ? JSON.parse(row.value) : {}; } catch { stored = {}; }
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function putSettings(env, auth, patch) {
  requireRole(auth, 'master');
  const cur = await getSettings(env);
  const allowed = Object.keys(DEFAULT_SETTINGS);
  for (const k of Object.keys(patch || {})) {
    if (!allowed.includes(k)) continue;
    if (SECRET_KEYS.includes(k) && (patch[k] === 'set' || patch[k] === undefined)) continue;   // masked value echoed back → keep
    cur[k] = patch[k];
  }
  cur.cutAltAgl = Math.min(12000, Math.max(200, Math.round(Number(cur.cutAltAgl) || 3000)));
  for (const k of SECRET_KEYS) cur[k] = String(cur[k] || '').trim().slice(0, 512);
  cur.quickRepliesGround = (cur.quickRepliesGround || []).map(String).slice(0, 6);
  cur.quickRepliesObserver = (cur.quickRepliesObserver || []).map(String).slice(0, 6);
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('app', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(cur)).run();
  await logAction(env, auth.user, 'settings.changed', Object.keys(patch || {}).join(', '));
  return publicSettings(cur);
}

export async function countUsers(env) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return r ? r.n : 0;
}

/** One-time bootstrap: creates the first (master) user while the table is empty. */
export async function setupMaster(env, body) {
  if ((await countUsers(env)) > 0) throw new HttpError(409, 'already set up');
  const name = String(body.user || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new HttpError(400, 'invalid user name');
  if (String(body.password || '').length < 6) throw new HttpError(400, 'password too short');
  await env.DB.prepare('INSERT INTO users (name, full_name, pw_hash, master, active, created_at) VALUES (?1, ?2, ?3, 1, 1, ?4)')
    .bind(name, String(body.fullName || name).slice(0, 80), await hashPassword(body.password), Date.now()).run();
  await logAction(env, name, 'setup', 'master user created');
  return { ok: true };
}

export async function login(env, body) {
  const name = String(body.user || '').trim().toLowerCase();
  const row = await env.DB.prepare('SELECT name, master, pw_hash, active, lang FROM users WHERE name = ?1').bind(name).first();
  if (!row || !row.active || !(await verifyPassword(String(body.password || ''), row.pw_hash))) throw new HttpError(401, 'bad credentials');
  await env.DB.prepare('UPDATE users SET last_login = ?1 WHERE name = ?2').bind(Date.now(), name).run();
  return row;
}

export async function listUsers(env, auth) {
  requireRole(auth, 'master');
  const { results } = await env.DB.prepare(`SELECT u.name, u.full_name AS fullName, u.master, u.active, u.last_login AS lastLogin,
      (SELECT COUNT(*) FROM ascents a WHERE a.owner = u.name) AS ascents FROM users u ORDER BY u.created_at`).all();
  return results.map((r) => ({ ...r, master: !!r.master }));
}

/** Create or update a ground user (name is the key). Password optional on update; `master` 0/1. */
export async function saveUser(env, auth, body) {
  requireRole(auth, 'master');
  const name = String(body.name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new HttpError(400, 'invalid user name');
  const existing = await env.DB.prepare('SELECT name FROM users WHERE name = ?1').bind(name).first();
  if (existing) {
    if (name === auth.user && body.active === 0) throw new HttpError(400, 'cannot deactivate yourself');
    if (name === auth.user && body.master !== undefined && !body.master) throw new HttpError(400, 'cannot remove your own master flag');
    const sets = []; const vals = [];
    if (body.fullName !== undefined) { sets.push('full_name = ?'); vals.push(String(body.fullName).slice(0, 80)); }
    if (body.master !== undefined) { sets.push('master = ?'); vals.push(body.master ? 1 : 0); }
    if (body.active !== undefined) { sets.push('active = ?'); vals.push(body.active ? 1 : 0); }
    if (body.lang !== undefined) { sets.push('lang = ?'); vals.push(body.lang === 'en' ? 'en' : 'de'); }
    if (body.password) { if (String(body.password).length < 6) throw new HttpError(400, 'password too short'); sets.push('pw_hash = ?'); vals.push(await hashPassword(body.password)); }
    if (sets.length) await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE name = ?`).bind(...vals, name).run();
    if (body.active === 0) await env.DB.prepare('DELETE FROM tokens WHERE user = ?1').bind(name).run();   // deactivation logs the user out
    await logAction(env, auth.user, 'user.updated', `${name} (${Object.keys(body).filter((k) => k !== 'password' && k !== 'name').join(', ')})`);
  } else {
    if (String(body.password || '').length < 6) throw new HttpError(400, 'password too short');
    await env.DB.prepare('INSERT INTO users (name, full_name, pw_hash, master, active, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(name, String(body.fullName || '').slice(0, 80), await hashPassword(body.password), body.master ? 1 : 0, body.active === 0 ? 0 : 1, Date.now()).run();
    await logAction(env, auth.user, 'user.created', `${name}${body.master ? ' · master' : ''}`);
  }
  return { ok: true };
}

export async function deleteUser(env, auth, name) {
  requireRole(auth, 'master');
  if (name === auth.user) throw new HttpError(400, 'cannot delete yourself');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tokens WHERE user = ?1').bind(name),
    env.DB.prepare('DELETE FROM users WHERE name = ?1').bind(name),
  ]);
  await logAction(env, auth.user, 'user.deleted', name);
  return { ok: true };
}
