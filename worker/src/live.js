// Live sessions: /api/ascents (D1) and the LiveSession Durable Object (one per ascent).
// The DO fans out telemetry/state/events from the ground station to every observer, replays
// the full telemetry history to late joiners, keeps the last 200 chat messages and presence.
// s2stueve ("Follow sonde ascent") connects to the same WebSocket with an observer token
// (POST /api/observer/login) – there is no anonymous guest path any more.

import { requireRole, HttpError } from './auth.js';
import { logAction } from './log.js';
import { getSettings } from './users.js';
import { notifyObservers } from './observers.js';

const CHUNK = 100;            // telemetry records per storage key (DO values are limited to 128 KB; a MET/INF record with params is ~820 B → 200 would exceed it)
const MAX_CHAT = 200;
const MAX_HISTORY = 20000;    // ~5.5 h at 1 Hz – plenty for one ascent

// ---- /api/ascents ---------------------------------------------------------------------------
/** Ground user creates a live session; returns {ascentId, notify:[…]} (WhatsApp links / send results). */
export async function createAscent(env, auth, body) {
  requireRole(auth, 'ground');
  const id = crypto.randomUUID().slice(0, 8) + '-' + Date.now().toString(36);
  const b = body || {};
  const meta = { start: b.start || null, plannedLaunch: b.plannedLaunch ?? null, cutAltAgl: b.cutAltAgl ?? null, frequencyHz: b.frequencyHz ?? null, sondeId: b.sondeId ?? null };
  // only one active ascent per owner: earlier ones are closed (observers see the newest)
  await env.DB.prepare('UPDATE ascents SET active = 0 WHERE owner = ?1 AND active = 1').bind(auth.user).run();
  await env.DB.prepare('INSERT INTO ascents (id, name, owner, created_at, active, meta) VALUES (?1, ?2, ?3, ?4, 1, ?5)')
    .bind(id, String(b.name || '').slice(0, 120), auth.user, Date.now(), JSON.stringify(meta)).run();
  await logAction(env, auth.user, 'ascent.created', id);
  let notify = [];
  try { notify = await notifyObservers(env, await getSettings(env), meta); } catch (e) { console.warn('notify failed', e); }
  return { ascentId: id, notify };
}

/** Ground users and observers alike (observers need the id to join the live channel). */
export async function listAscents(env, auth, activeOnly) {
  requireRole(auth);
  const q = activeOnly ? 'SELECT id, name, owner, created_at AS createdAt, active, meta FROM ascents WHERE active = 1 ORDER BY created_at DESC LIMIT 20'
    : 'SELECT id, name, owner, created_at AS createdAt, active, meta FROM ascents ORDER BY created_at DESC LIMIT 100';
  const { results } = await env.DB.prepare(q).all();
  return results.map((r) => ({ ...r, meta: safeJson(r.meta) }));
}

export async function closeAscent(env, auth, id) {
  requireRole(auth, 'ground');
  await env.DB.prepare('UPDATE ascents SET active = 0 WHERE id = ?1').bind(id).run();
  await doFetch(env, id, '/close', {});
  return { ok: true };
}

/** Ground user removes an observer from a running ascent: socket closed + blocked for this ascent. */
export async function kickObserver(env, auth, id, body) {
  requireRole(auth, 'ground');
  const observerId = Number(body && body.observerId);
  if (!observerId) throw new HttpError(400, 'observerId required');
  const r = await doFetch(env, id, '/kick', { observerId });
  await logAction(env, auth.user, 'observer.kicked', `#${observerId} · ${id}`);
  return r;
}

async function doFetch(env, ascentId, path, body) {
  const stub = env.LIVE.get(env.LIVE.idFromName(ascentId));
  const res = await stub.fetch(`https://do${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return res.json().catch(() => ({ ok: res.ok }));
}
function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

/**
 * Worker-side WebSocket entry: /live/:ascentId?token=…  (ground-user token or observer token).
 * Authentication happens here; the DO trusts the X-User / X-Role / X-Observer headers it receives.
 */
export async function handleLive(request, env, url, auth) {
  if (request.headers.get('Upgrade') !== 'websocket') throw new HttpError(426, 'websocket expected');
  if (!auth) throw new HttpError(401, 'login or observer code required');
  const ascentId = decodeURIComponent(url.pathname.split('/')[2] || '');
  const stub = env.LIVE.get(env.LIVE.idFromName(ascentId));
  const headers = new Headers(request.headers);
  headers.set('X-User', auth.user); headers.set('X-Role', auth.role); headers.set('X-Observer', auth.observerId ? String(auth.observerId) : ''); headers.set('X-Ascent', ascentId);
  return stub.fetch(new Request(request.url, { method: 'GET', headers }));
}

// ---- Durable Object ---------------------------------------------------------------------------
export class LiveSession {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.sockets = new Map();       // WebSocket → {user, role, observerId, since}
    this.history = null;            // loaded lazily
    this.chat = null;
    this.lastState = null;
    this.closed = false;
    this.blocked = [];              // observer ids kicked from this ascent
  }

  async load() {
    if (this.history) return;
    const items = await this.state.storage.list({ prefix: 'h:' });
    const keys = [...items.keys()].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
    this.history = keys.flatMap((k) => items.get(k));
    this.chat = (await this.state.storage.get('chat')) || [];
    this.lastState = (await this.state.storage.get('state')) || null;
    this.closed = (await this.state.storage.get('closed')) || false;
    this.blocked = (await this.state.storage.get('blocked')) || [];
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    if (url.pathname === '/close' && request.method === 'POST') {
      this.closed = true; await this.state.storage.put('closed', true);
      this.broadcast({ type: 'closed' });
      return Response.json({ ok: true });
    }
    if (url.pathname === '/kick' && request.method === 'POST') {
      const { observerId } = await request.json().catch(() => ({}));
      return Response.json({ ok: true, closed: await this.kick(Number(observerId)) });
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const observerId = Number(request.headers.get('X-Observer')) || null;
    if (observerId && this.blocked.includes(observerId)) return new Response('kicked', { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const meta = { user: request.headers.get('X-User') || 'anon', role: request.headers.get('X-Role') === 'ground' ? 'ground' : 'observer', observerId, since: Date.now() };
    server.accept();
    this.sockets.set(server, meta);
    server.addEventListener('message', (ev) => this.onMessage(server, meta, ev.data));
    const bye = () => { this.sockets.delete(server); this.broadcastPresence(); };
    server.addEventListener('close', bye); server.addEventListener('error', bye);
    // replay: full telemetry history + chat + last state, then presence to everyone
    this.send(server, { type: 'history', records: this.history, chat: this.chat, state: this.lastState, closed: this.closed });
    this.broadcastPresence();
    if (meta.role !== 'ground') this.pushChat({ type: 'chat', user: meta.user, role: 'system', text: `${meta.user} joined`, t: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Close every socket of that observer and remember the id so a reconnect is refused. */
  async kick(observerId) {
    if (!observerId) return 0;
    if (!this.blocked.includes(observerId)) { this.blocked.push(observerId); await this.state.storage.put('blocked', this.blocked); }
    let n = 0, name = '';
    for (const [ws, m] of this.sockets) if (m.observerId === observerId) { name = m.user; this.sockets.delete(ws); try { ws.close(4001, 'kicked'); } catch { /* already gone */ } n++; }
    this.broadcastPresence();
    if (name) this.pushChat({ type: 'chat', user: name, role: 'system', text: `${name} removed`, t: Date.now() });
    return n;
  }

  onMessage(ws, meta, data) {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    const isGround = meta.role === 'ground';   // WHY: only the ground station may feed telemetry/state/events – observers can never spoof the profile
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
        this.pushChat({ type: 'chat', user: meta.user, role: meta.role, observerId: meta.observerId, text, t: Date.now() });
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
    const users = [...this.sockets.values()].map((m) => ({ name: m.user, role: m.role, observerId: m.observerId, since: m.since }));
    this.broadcast({ type: 'presence', users });
  }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch { /* closing */ } }
  broadcast(obj, except = null) {
    const s = JSON.stringify(obj);
    for (const ws of this.sockets.keys()) if (ws !== except) { try { ws.send(s); } catch { this.sockets.delete(ws); } }
  }
}
