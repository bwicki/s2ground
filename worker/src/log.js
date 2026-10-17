// Activity log (D1). Written by the Worker itself (login, setup, user changes) and by the app
// (POST /api/log for every phase step and sonde command).

import { requireRole } from './auth.js';

export async function logAction(env, user, action, detail = '') {
  try {
    await env.DB.prepare('INSERT INTO activity_log (t, user, action, detail) VALUES (?1, ?2, ?3, ?4)')
      .bind(Date.now(), String(user).slice(0, 32), String(action).slice(0, 64), String(detail || '').slice(0, 500)).run();
  } catch (e) { console.warn('log failed', e); }
}

export async function listLog(env, auth, limit = 200) {
  requireRole(auth, 'master');
  const n = Math.max(1, Math.min(2000, Number(limit) || 200));
  const { results } = await env.DB.prepare('SELECT t, user, action, detail FROM activity_log ORDER BY t DESC LIMIT ?1').bind(n).all();
  return results;
}

export async function addLog(env, auth, body) {
  requireRole(auth);
  if (!body || !body.action) return { ok: false };
  await logAction(env, auth.user, body.action, body.detail);
  return { ok: true };
}
