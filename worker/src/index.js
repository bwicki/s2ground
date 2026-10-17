// S2 Ground – Cloudflare Worker entry: JSON API (/api/*), live WebSockets (/live/:id),
// static app (assets binding). See docs/INTERFACE.md §4 for the API table.

import { authenticate, createToken, deleteToken, HttpError, requireRole } from './auth.js';
import { countUsers, setupMaster, login, listUsers, saveUser, deleteUser, getSettings, putSettings, publicSettings } from './users.js';
import { airspaces } from './airspaces.js';
import { listLog, addLog, logAction } from './log.js';
import { createAscent, listAscents, closeAscent, handleLive } from './live.js';

export { LiveSession } from './live.js';

// ---- small helpers ----------------------------------------------------------------------------
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.APP_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !(allowed.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Max-Age': '600', Vary: 'Origin' };
}

// Very small in-memory rate limiter (per isolate): login attempts per client IP.
// WHY: brute-force protection without extra infrastructure; good enough for a private team app.
const attempts = new Map();
function rateLimited(ip, max = 10, windowMs = 10 * 60e3) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now); attempts.set(ip, list);
  if (attempts.size > 5000) attempts.clear();
  return list.length > max;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

// ---- API router -------------------------------------------------------------------------------------
async function api(request, env, url, ctx) {
  const path = url.pathname.replace(/\/+$/, '');
  const m = request.method;
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const auth = await authenticate(env, request, url);

  if (path === '/api/health') return json({ ok: true, t: Date.now() });

  if (path === '/api/setup') {
    if (m === 'GET') return json({ needed: (await countUsers(env)) === 0 });
    if (m === 'POST') { if (rateLimited(ip, 5)) throw new HttpError(429, 'too many attempts'); return json(await setupMaster(env, await readJson(request))); }
  }
  if (path === '/api/login' && m === 'POST') {
    if (rateLimited(ip)) throw new HttpError(429, 'too many attempts');
    const body = await readJson(request);
    const user = await login(env, body);
    const token = await createToken(env, user.name);
    await logAction(env, user.name, 'login', (request.headers.get('User-Agent') || '').slice(0, 80));
    return json({ token, user: user.name, role: user.role, lang: user.lang });
  }
  if (path === '/api/logout' && m === 'POST') { await deleteToken(env, auth && auth.token); return json({ ok: true }); }

  if (path === '/api/me' && m === 'GET') { requireRole(auth); return json({ user: auth.user, role: auth.role, lang: auth.lang, settings: publicSettings(await getSettings(env)) }); }

  if (path === '/api/users' && m === 'GET') return json(await listUsers(env, auth));
  if (path === '/api/users' && m === 'POST') return json(await saveUser(env, auth, await readJson(request)));
  const userDel = /^\/api\/users\/([^/]+)$/.exec(path);
  if (userDel && m === 'DELETE') return json(await deleteUser(env, auth, decodeURIComponent(userDel[1]).toLowerCase()));

  if (path === '/api/settings' && m === 'GET') { requireRole(auth); return json(publicSettings(await getSettings(env))); }
  if (path === '/api/airspaces' && m === 'GET') { requireRole(auth); return airspaces(env, url, ctx); }
  if (path === '/api/settings' && m === 'PUT') return json(await putSettings(env, auth, await readJson(request)));

  if (path === '/api/log' && m === 'GET') return json(await listLog(env, auth, url.searchParams.get('limit')));
  if (path === '/api/log' && m === 'POST') return json(await addLog(env, auth, await readJson(request)));

  if (path === '/api/ascents' && m === 'POST') return json(await createAscent(env, auth, await readJson(request)));
  if (path === '/api/ascents' && m === 'GET') return json(await listAscents(env, auth, url.searchParams.get('active') === '1'));
  const ascClose = /^\/api\/ascents\/([^/]+)\/close$/.exec(path);
  if (ascClose && m === 'POST') return json(await closeAscent(env, auth, decodeURIComponent(ascClose[1])));

  throw new HttpError(404, 'not found');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname.startsWith('/api/')) {
        const res = await api(request, env, url, ctx);
        for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
        return res;
      }
      if (url.pathname.startsWith('/live/')) {
        const auth = await authenticate(env, request, url);
        return await handleLive(request, env, url, auth);
      }
      // static app; security headers for the HTML
      const res = await env.ASSETS.fetch(request);
      if ((res.headers.get('Content-Type') || '').includes('text/html')) {
        const h = new Headers(res.headers);
        h.set('X-Frame-Options', 'DENY'); h.set('Referrer-Policy', 'strict-origin-when-cross-origin'); h.set('X-Content-Type-Options', 'nosniff');
        return new Response(res.body, { status: res.status, headers: h });
      }
      return res;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 ? 'internal error' : e.message }, status, cors);
    }
  },
};
