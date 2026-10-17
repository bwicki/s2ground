// Live sessions: /api/ascents (D1) and the LiveSession Durable Object (one per ascent).
// The DO fans out telemetry/state/events from the ground station to every observer, replays
// the full telemetry history to late joiners, keeps the last 200 chat messages and presence.
// s2stueve ("Follow sonde ascent") connects to the same WebSocket with a login token or a
// guest follow code.

import { requireRole, followCode, HttpError } from './auth.js';
import { logAction } from './log.js';

const CHUNK = 100;            // telemetry records per storage key (DO values are limited to 128 KB; a MET/INF record with params is ~820 B → 200 would exceed it)
const MAX_CHAT = 200;
const MAX_HISTORY = 20000;    // ~5.5 h at 1 Hz – plenty for one ascent

// ---- /api/ascents ---------------------------------------------------------------------------
export async function createAscent(env, auth, body) {
  requireRole(auth, 'master', 'ground');
  const id = crypto.randomUUID().slice(0, 8) + '-' + Date.now().toString(36);
  const code = followCode();
  // only one active ascent per owner: earlier ones are closed (observers see the newest)
  await env.DB.prepare('UPDATE ascents SET active = 0 WHERE owner = ?1 AND active = 1').bind(auth.user).run();
  await env.DB.prepare('INSERT INTO ascents (id, name, owner, follow_code, created_at, active, meta) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)')
    .bind(id, String((body && body.name) || '').slice(0, 120), auth.user, code, Date.now(), JSON.stringify({ start: body && body.start, plannedLaunch: body && body.plannedLaunch })).run();
  await logAction(env, auth.user, 'ascent.created', `${id} · ${code}`);
  return { ascentId: id, followCode: code };
}

export async function listAscents(env, auth, activeOnly) {
  requireRole(auth);
  const q = activeOnly ? 'SELECT id, name, owner, follow_code AS followCode, created_at AS createdAt, active, meta FROM ascents WHERE active = 1 ORDER BY created_at DESC LIMIT 20'
    : 'SELECT id, name, owner, follow_code AS followCode, created_at AS createdAt, active, meta FROM ascents ORDER BY created_at DESC LIMIT 100';
  const { results } = await env.DB.prepare(q).all();
  return results.map((r) => ({ ...r, meta: safeJson(r.meta), followCode: auth.role === 'master' || auth.user === r.owner ? r.followCode : undefined }));
}

export async function closeAscent(env, auth, id) {
  requireRole(auth, 'master', 'ground');
  await env.DB.prepare('UPDATE ascents SET active = 0 WHERE id = ?1').bind(id).run();
  const stub = env.LIVE.get(env.LIVE.idFromName(id));
  await stub.fetch('https://do/close', { method: 'POST' });
  return { ok: true };
}

/** Guest access: follow code → ascent id (or null). */
export async function ascentByCode(env, code) {
  const row = await env.DB.prepare('SELECT id FROM ascents WHERE follow_code = ?1 AND active = 1').bind(String(code || '').toUpperCase().trim()).first();
  return row ? row.id : null;
}

function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

/**
 * Worker-side WebSocket entry: /live/:ascentId?token=…&role=… | ?code=… (guest).
 * Authentication happens here; the DO trusts the X-User / X-Role headers it receives.
 */
export async function handleLive(request, env, url, auth) {
  if (request.headers.get('Upgrade') !== 'websocket') throw new HttpError(426, 'websocket expected');
  const parts = url.pathname.split('/');
  let ascentId = decodeURIComponent(parts[2] || '');
  let user, role;
  if (auth) {
    user = auth.user;
    // a logged-in user may ask for a lower role (observer) but never a higher one than their account
    // Only known role names: Headers.set() trims whitespace, so an unknown value like " ground" would reach the DO as "ground".
    const KNOWN = ['master', 'ground', 'command', 'observer', 'guest'];
    const asked = KNOWN.includes(url.searchParams.get('role')) ? url.searchParams.get('role') : auth.role;
    role = asked === 'ground' && !['master', 'ground'].includes(auth.role) ? 'observer' : asked === 'master' && auth.role !== 'master' ? 'observer' : asked;
  } else {
    const code = url.searchParams.get('code');
    const byCode = code ? await ascentByCode(env, code) : null;
    if (!byCode) throw new HttpError(401, 'login or follow code required');
    if (ascentId !== byCode) ascentId = byCode;
    user = `gast-${code.toUpperCase()}`; role = 'guest';
  }
  const stub = env.LIVE.get(env.LIVE.idFromName(ascentId));
  const headers = new Headers(request.headers);
  headers.set('X-User', user); headers.set('X-Role', role); headers.set('X-Ascent', ascentId);
  return stub.fetch(new Request(request.url, { method: 'GET', headers }));
}

// ---- Durable Object ---------------------------------------------------------------------------
export class LiveSession {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.sockets = new Map();       // WebSocket → {user, role, since}
    this.history = null;            // loaded lazily
    this.chat = null;
    this.lastState = null;
    this.closed = false;
    this.pendingChunk = 0;
  }

  async load() {
    if (this.history) return;
    const items = await this.state.storage.list({ prefix: 'h:' });
    const keys = [...items.keys()].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
    this.history = keys.flatMap((k) => items.get(k));
    this.chat = (await this.state.storage.get('chat')) || [];
    this.lastState = (await this.state.storage.get('state')) || null;
    this.closed = (await this.state.storage.get('closed')) || false;
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    if (url.pathname === '/close' && request.method === 'POST') {
      this.closed = true; await this.state.storage.put('closed', true);
      this.broadcast({ type: 'closed' });
      return new Response('ok');
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const meta = { user: request.headers.get('X-User') || 'anon', role: request.headers.get('X-Role') || 'guest', since: Date.now() };
    server.accept();
    this.sockets.set(server, meta);
    server.addEventListener('message', (ev) => this.onMessage(server, meta, ev.data));
    const bye = () => { this.sockets.delete(server); this.broadcastPresence(); };
    server.addEventListener('close', bye); server.addEventListener('error', bye);
    // replay: full telemetry history + chat + last state, then presence to everyone
    this.send(server, { type: 'history', records: this.history, chat: this.chat, state: this.lastState, closed: this.closed });
    this.broadcastPresence();
    if (meta.role !== 'ground' && meta.role !== 'master') this.pushChat({ type: 'chat', user: meta.user, role: 'system', text: `${meta.user} joined`, t: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(ws, meta, data) {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    const isGround = meta.role === 'ground' || meta.role === 'master';
    switch (m.type) {
      case 'telemetry':
        if (!isGround || !m.rec) return;
        this.history.push(m.rec);
        if (this.history.length > MAX_HISTORY) this.history.shift();
        this.persistHistory();
        this.broadcast(m, ws);
        break;
      case 'state':
        if (!isGround) return;
        this.lastState = m.state || null; this.state.storage.put('state', this.lastState);
        this.broadcast(m, ws);
        break;
      case 'event':
        if (!isGround) return;
        this.broadcast(m, ws);
        break;
      case 'chat': {
        const text = String(m.text || '').slice(0, 500).trim();
        if (!text) return;
        this.pushChat({ type: 'chat', user: meta.user, role: meta.role, text, t: Date.now() });
        break;
      }
      case 'ping': this.send(ws, { type: 'pong', t: Date.now() }); break;
      default: break;
    }
  }

  pushChat(msg) {
    this.chat.push(msg);
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
    this.state.storage.put('chat', this.chat);
    this.broadcast(msg);
  }

  /** Persist history in chunks of CHUNK records; only the last (growing) chunk is rewritten. */
  persistHistory() {
    const n = this.history.length;
    const chunk = Math.floor((n - 1) / CHUNK);
    const slice = this.history.slice(chunk * CHUNK, (chunk + 1) * CHUNK);
    // write every 10 records (and always on chunk completion) to limit storage writes
    if (n % 10 === 0 || slice.length === CHUNK) this.state.storage.put(`h:${chunk}`, slice);
  }

  broadcastPresence() {
    const users = [...this.sockets.values()].map((m) => ({ name: m.user, role: m.role, since: m.since }));
    this.broadcast({ type: 'presence', users });
  }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch { /* closing */ } }
  broadcast(obj, except = null) {
    const s = JSON.stringify(obj);
    for (const ws of this.sockets.keys()) if (ws !== except) { try { ws.send(s); } catch { this.sockets.delete(ws); } }
  }
}
