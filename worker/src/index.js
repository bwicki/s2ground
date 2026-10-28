// S2 Ground – Cloudflare Worker entry (API only): JSON API (/api/*) and live WebSockets (/live/:id).
// The web app itself is served by GitHub Pages (s2ground.wicki.aero) and reaches this Worker
// through src/config.js (apiBase) – see docs/INTERFACE.md §4 for the API table.

import { authenticate, createToken, deleteToken, HttpError, requireRole } from './auth.js';
import { countUsers, setupMaster, login, listUsers, saveUser, deleteUser, getSettings, putSettings, publicSettings } from './users.js';
import { listObservers, createObserver, updateObserver, revokeObserver, reactivateObserver, observerLogins, observerLogin } from './observers.js';
import { airspaces, testOpenAipKey } from './airspaces.js';
import { listLog, addLog, logAction } from './log.js';
import { createAscent, listAscents, closeAscent, kickObserver, handleLive } from './live.js';

export { LiveSession } from './live.js';

// ---- small helpers ----------------------------------------------------------------------------
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });

// CORS allow-list from wrangler.toml APP_ORIGINS (the app on GitHub Pages, s2stueve, local dev).
// WHY: app and API live on different origins now, so every browser call is a cross-origin request.
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
  const idOf = (re) => { const x = re.exec(path); return x ? decodeURIComponent(x[1]) : null; };

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
    return json({ token, user: user.name, role: 'ground', master: !!user.master, lang: user.lang });
  }
  if (path === '/api/observer/login' && m === 'POST') {
    if (rateLimited(ip)) throw new HttpError(429, 'too many attempts');
    return json(await observerLogin(env, await readJson(request), request));
  }
  if (path === '/api/logout' && m === 'POST') { await deleteToken(env, auth && auth.token); return json({ ok: true }); }

  if (path === '/api/me' && m === 'GET') {
    requireRole(auth);
    const base = { user: auth.user, role: auth.role, master: !!auth.master, observerId: auth.observerId || null, lang: auth.lang || null };
    if (auth.role === 'ground') return json({ ...base, settings: publicSettings(await getSettings(env)) });
    // Observers (s2stueve Follow mode) only get the quick replies the master configured for them – nothing else.
    const s = await getSettings(env);
    return json({ ...base, settings: { quickRepliesObserver: s.quickRepliesObserver || [] } });
  }

  if (path === '/api/users' && m === 'GET') return json(await listUsers(env, auth));
  if (path === '/api/users' && m === 'POST') return json(await saveUser(env, auth, await readJson(request)));
  const userDel = idOf(/^\/api\/users\/([^/]+)$/);
  if (userDel && m === 'DELETE') return json(await deleteUser(env, auth, userDel.toLowerCase()));

  // observers (master): codes, revoke/reactivate, login history
  if (path === '/api/observers' && m === 'GET') return json(await listObservers(env, auth));
  if (path === '/api/observers' && m === 'POST') return json(await createObserver(env, auth, await readJson(request)));
  const obsId = Number(idOf(/^\/api\/observers\/(\d+)(?:\/[a-z]+)?$/));
  if (obsId && m === 'PUT' && path === `/api/observers/${obsId}`) return json(await updateObserver(env, auth, obsId, await readJson(request)));
  if (obsId && m === 'POST' && path.endsWith('/revoke')) return json(await revokeObserver(env, auth, obsId));
  if (obsId && m === 'POST' && path.endsWith('/reactivate')) return json(await reactivateObserver(env, auth, obsId));
  if (obsId && m === 'GET' && path.endsWith('/logins')) return json(await observerLogins(env, auth, obsId, url.searchParams.get('limit')));

  if (path === '/api/settings' && m === 'GET') { requireRole(auth, 'ground'); return json(publicSettings(await getSettings(env))); }
  if (path === '/api/airspaces/test' && m === 'GET') { requireRole(auth, 'master'); return json(await testOpenAipKey(env)); }
  if (path === '/api/airspaces' && m === 'GET') { requireRole(auth, 'ground'); return airspaces(env, url, ctx); }
  if (path === '/api/settings' && m === 'PUT') return json(await putSettings(env, auth, await readJson(request)));

  if (path === '/api/log' && m === 'GET') return json(await listLog(env, auth, url.searchParams.get('limit')));
  if (path === '/api/log' && m === 'POST') return json(await addLog(env, auth, await readJson(request)));

  if (path === '/api/ascents' && m === 'POST') return json(await createAscent(env, auth, await readJson(request)));
  if (path === '/api/ascents' && m === 'GET') return json(await listAscents(env, auth, url.searchParams.get('active') === '1'));
  const ascClose = idOf(/^\/api\/ascents\/([^/]+)\/close$/);
  if (ascClose && m === 'POST') return json(await closeAscent(env, auth, ascClose));
  const ascKick = idOf(/^\/api\/ascents\/([^/]+)\/kick$/);
  if (ascKick && m === 'POST') return json(await kickObserver(env, auth, ascKick, await readJson(request)));

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
      // Everything else: this Worker serves no pages – the app lives on GitHub Pages.
      return json({ error: 'not found', app: 'https://s2ground.wicki.aero' }, 404, cors);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 ? 'internal error' : e.message }, status, cors);
    }
  },
};
