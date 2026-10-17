// Password hashing (PBKDF2-SHA256 via WebCrypto, no dependencies) and bearer tokens stored
// in D1 with an expiry. Two kinds of principals: ground users (users table, flag `master`)
// and observers (observers table, access code, no password). auth = {user, role, master, observerId, token}.

const ITER = 100000;
const enc = new TextEncoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITER);
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [algo, iter, salt, hash] = (stored || '').split('$');
  if (algo !== 'pbkdf2') return false;
  const got = new Uint8Array(await pbkdf2(password, unb64(salt), Number(iter)));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;                                        // constant-time compare
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

export function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Alphabet for observer codes: no 0/O/1/I so a code read over the phone is unambiguous. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Observer access code like "7K2M4QX9" (8 chars → 32^8 ≈ 1.1e12 combinations). */
export function observerCode(len = 8) {
  const a = crypto.getRandomValues(new Uint8Array(len));
  return [...a].map((v) => CODE_ALPHABET[v % CODE_ALPHABET.length]).join('');
}
/** Normalise what a person typed: upper case, spaces/dashes removed (the alphabet has no 0/O/1/I anyway). */
export function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function createToken(env, user, observerId = null) {
  const token = randomToken();
  const now = Date.now();
  const hours = Number(env.TOKEN_HOURS || 24);
  await env.DB.prepare('INSERT INTO tokens (token, user, observer_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(token, user, observerId, now, now + hours * 3600e3).run();
  // opportunistic cleanup of expired tokens (cheap, keeps the table small)
  await env.DB.prepare('DELETE FROM tokens WHERE expires_at < ?1').bind(now).run();
  return token;
}

export async function deleteToken(env, token) {
  if (token) await env.DB.prepare('DELETE FROM tokens WHERE token = ?1').bind(token).run();
}

/**
 * Resolve a bearer token (header or ?token=) to the principal, or null.
 * Ground user: {user, role:'ground', master:boolean, lang, token}
 * Observer:    {user: displayName, role:'observer', observerId, token}  (null once the code is revoked)
 */
export async function authenticate(env, request, url) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (url && url.searchParams.get('token')) || null;
  if (!token) return null;
  const row = await env.DB.prepare('SELECT token, user, observer_id, expires_at FROM tokens WHERE token = ?1').bind(token).first();
  if (!row || row.expires_at < Date.now()) return null;
  if (row.observer_id) {
    const o = await env.DB.prepare('SELECT id, display_name, label, revoked_at FROM observers WHERE id = ?1').bind(row.observer_id).first();
    if (!o || o.revoked_at) return null;                 // revoking a code logs the observer out immediately
    return { user: o.display_name || o.label, role: 'observer', master: false, observerId: o.id, token };
  }
  const u = await env.DB.prepare('SELECT name, master, active, lang FROM users WHERE name = ?1').bind(row.user).first();
  if (!u || !u.active) return null;
  return { user: u.name, role: 'ground', master: !!u.master, lang: u.lang, token };
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
/**
 * requireRole(auth)                → any authenticated principal (ground user or observer)
 * requireRole(auth, 'ground')      → any ground user (master or not)
 * requireRole(auth, 'master')      → ground user with the master flag
 * requireRole(auth, 'observer')    → observer token; several names = any of them
 */
export function requireRole(auth, ...roles) {
  if (!auth) throw new HttpError(401, 'unauthorized');
  if (!roles.length) return auth;
  const ok = roles.some((r) => (r === 'master' ? auth.master : r === 'ground' ? auth.role === 'ground' : auth.role === r));
  if (!ok) throw new HttpError(403, 'forbidden');
  return auth;
}
