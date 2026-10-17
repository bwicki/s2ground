// Observers (Beobachter): people without a password who follow an ascent in s2stueve with a
// permanent 6-character access code. The master creates/revokes codes in the admin page; every
// join is written to observer_logins so the master can see who used which code when.
// Observers can read everything and write in the chat; hardware actions stay with ground users
// (enforced by requireRole('ground') in index.js and by the Durable Object for the live channel).

import { requireRole, HttpError, observerCode, normalizeCode, createToken } from './auth.js';
import { logAction } from './log.js';
import { buildNotifyMessage, waUrl, waConfigured, sendWhatsApp } from './whatsapp.js';

const MOBILE_RE = /^\+[1-9]\d{7,14}$/;          // E.164
const CODE_RE = /^[2-9A-HJ-NP-Z]{6}$/;

function cleanMobile(s) {
  const m = String(s || '').replace(/[\s()-]/g, '').replace(/^00/, '+');
  if (!m) return '';
  if (!MOBILE_RE.test(m)) throw new HttpError(400, 'E_MOBILE_FORMAT');
  return m;
}
const row2obs = (r) => ({ id: r.id, code: r.code, label: r.label, displayName: r.display_name || '', mobile: r.mobile || '', whatsapp: !!r.whatsapp, createdBy: r.created_by, createdAt: r.created_at, revokedAt: r.revoked_at || null, lastLoginAt: r.last_login_at || null, loginCount: r.login_count || 0 });

// ---- master: manage codes ------------------------------------------------------------------
export async function listObservers(env, auth) {
  requireRole(auth, 'master');
  const { results } = await env.DB.prepare('SELECT * FROM observers ORDER BY revoked_at IS NOT NULL, created_at').all();
  return results.map(row2obs);
}

/** Create a code. The code is returned here (and listed later – it is a viewing code, not a secret). */
export async function createObserver(env, auth, body) {
  requireRole(auth, 'master');
  const label = String((body && body.label) || '').trim().slice(0, 60);
  if (label.length < 2) throw new HttpError(400, 'E_LABEL_REQUIRED');
  const mobile = cleanMobile(body && body.mobile);
  const whatsapp = body && body.whatsapp && mobile ? 1 : 0;
  // UNIQUE on code: retry on the (astronomically unlikely) collision instead of failing the request
  for (let i = 0; i < 5; i++) {
    const code = observerCode();
    try {
      const r = await env.DB.prepare('INSERT INTO observers (code, label, mobile, whatsapp, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(code, label, mobile, whatsapp, auth.user, Date.now()).run();
      await logAction(env, auth.user, 'observer.created', `${label} · ${code}`);
      return { id: r.meta.last_row_id, code, label, mobile, whatsapp: !!whatsapp };
    } catch (e) { if (!/UNIQUE/i.test(String(e.message))) throw e; }
  }
  throw new HttpError(500, 'could not allocate a code');
}

/** Update label / mobile / whatsapp flag (not the code). */
export async function updateObserver(env, auth, id, body) {
  requireRole(auth, 'master');
  const sets = [], vals = [];
  if (body.label !== undefined) { const l = String(body.label).trim().slice(0, 60); if (l.length < 2) throw new HttpError(400, 'E_LABEL_REQUIRED'); sets.push('label = ?'); vals.push(l); }
  if (body.mobile !== undefined) { sets.push('mobile = ?'); vals.push(cleanMobile(body.mobile)); }
  if (body.whatsapp !== undefined) { sets.push('whatsapp = ?'); vals.push(body.whatsapp ? 1 : 0); }
  if (sets.length) await env.DB.prepare(`UPDATE observers SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
  await logAction(env, auth.user, 'observer.updated', `#${id} (${Object.keys(body).join(', ')})`);
  return { ok: true };
}

export async function revokeObserver(env, auth, id) {
  requireRole(auth, 'master');
  await env.DB.batch([
    env.DB.prepare('UPDATE observers SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL').bind(Date.now(), id),
    env.DB.prepare('DELETE FROM tokens WHERE observer_id = ?1').bind(id),      // logs the observer out everywhere
  ]);
  await logAction(env, auth.user, 'observer.revoked', `#${id}`);
  return { ok: true };
}

export async function reactivateObserver(env, auth, id) {
  requireRole(auth, 'master');
  await env.DB.prepare('UPDATE observers SET revoked_at = NULL WHERE id = ?1').bind(id).run();
  await logAction(env, auth.user, 'observer.reactivated', `#${id}`);
  return { ok: true };
}

export async function observerLogins(env, auth, id, limit = 50) {
  requireRole(auth, 'master');
  const { results } = await env.DB.prepare('SELECT at, ip, user_agent AS userAgent, display_name AS displayName, ascent_id AS ascentId FROM observer_logins WHERE observer_id = ?1 ORDER BY at DESC LIMIT ?2').bind(id, Math.min(500, Number(limit) || 50)).all();
  return results;
}

// ---- observer: join with code ----------------------------------------------------------------
/** POST /api/observer/login {code, displayName} → {token, role:'observer', displayName, observerId}. */
export async function observerLogin(env, body, request) {
  const code = normalizeCode(body && body.code);
  if (!CODE_RE.test(code)) throw new HttpError(403, 'E_CODE_UNKNOWN');
  const displayName = String((body && body.displayName) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (displayName.length < 2) throw new HttpError(400, 'E_NAME_REQUIRED');
  const o = await env.DB.prepare('SELECT id, label, revoked_at FROM observers WHERE code = ?1').bind(code).first();
  if (!o) throw new HttpError(403, 'E_CODE_UNKNOWN');
  if (o.revoked_at) throw new HttpError(403, 'E_CODE_REVOKED');
  const now = Date.now();
  const active = await env.DB.prepare('SELECT id FROM ascents WHERE active = 1 ORDER BY created_at DESC LIMIT 1').first();
  await env.DB.batch([
    env.DB.prepare('UPDATE observers SET display_name = ?1, last_login_at = ?2, login_count = login_count + 1 WHERE id = ?3').bind(displayName, now, o.id),
    env.DB.prepare('INSERT INTO observer_logins (observer_id, at, ip, user_agent, display_name, ascent_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(o.id, now, request.headers.get('CF-Connecting-IP') || '', (request.headers.get('User-Agent') || '').slice(0, 160), displayName, active ? active.id : null),
  ]);
  const token = await createToken(env, `obs:${o.id}`, o.id);
  await logAction(env, displayName, 'observer.login', `${o.label} · ${code}`);
  return { token, role: 'observer', displayName, observerId: o.id, label: o.label };
}

// ---- notifications about a new ascent ---------------------------------------------------------
/**
 * For every active observer with mobile + whatsapp: the standard message, a wa.me link (stage 1)
 * and – when the Cloud API is configured (stage 2) – the result of the automatic send.
 */
export async function notifyObservers(env, settings, meta) {
  const { results } = await env.DB.prepare("SELECT id, code, label, mobile FROM observers WHERE revoked_at IS NULL AND whatsapp = 1 AND mobile <> '' ORDER BY created_at").all();
  const auto = waConfigured(settings);
  const out = [];
  for (const o of results) {
    const text = buildNotifyMessage(meta, o.code);
    const item = { observerId: o.id, label: o.label, mobile: o.mobile, waUrl: waUrl(o.mobile, text), sent: false, error: null };
    if (auto) { const r = await sendWhatsApp(env, settings, o.mobile, text); item.sent = r.ok; item.error = r.error; }
    out.push(item);
  }
  return out;
}
