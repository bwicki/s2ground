// Password hashing (PBKDF2-SHA256 via WebCrypto, no dependencies) and bearer tokens stored
// in D1 with an expiry. Roles: master > ground/command > observer > guest.

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

/** Human-friendly follow code like "7K2-M4Q" (no 0/O/1/I). */
export function followCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const a = crypto.getRandomValues(new Uint8Array(6));
  const s = [...a].map((v) => alphabet[v % alphabet.length]).join('');
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

export async function createToken(env, user) {
  const token = randomToken();
  const now = Date.now();
  const hours = Number(env.TOKEN_HOURS || 24);
  await env.DB.prepare('INSERT INTO tokens (token, user, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)').bind(token, user, now, now + hours * 3600e3).run();
  // opportunistic cleanup of expired tokens (cheap, keeps the table small)
  await env.DB.prepare('DELETE FROM tokens WHERE expires_at < ?1').bind(now).run();
  return token;
}

export async function deleteToken(env, token) {
  if (token) await env.DB.prepare('DELETE FROM tokens WHERE token = ?1').bind(token).run();
}

/** Resolve a bearer token (header or ?token=) to {user, role, token} or null. */
export async function authenticate(env, request, url) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (url && url.searchParams.get('token')) || null;
  if (!token) return null;
  const row = await env.DB.prepare('SELECT t.token, t.expires_at, u.name, u.role, u.active, u.lang FROM tokens t JOIN users u ON u.name = t.user WHERE t.token = ?1').bind(token).first();
  if (!row || row.expires_at < Date.now() || !row.active) return null;
  return { user: row.name, role: row.role, lang: row.lang, token };
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireRole(auth, ...roles) {
  if (!auth) throw new HttpError(401, 'unauthorized');
  if (roles.length && !roles.includes(auth.role)) throw new HttpError(403, 'forbidden');
  return auth;
}
