// Worker API client (docs/INTERFACE.md §4) with a built-in mock.
// Every /api path is prefixed with config.apiBase (src/config.js) – the app is on GitHub Pages,
// the Worker on workers.dev. Mock mode (?sim=1 without ?api=1) keeps users, observers, settings
// and the activity log in memory so the whole app runs without the Worker.
// Demo ground users: bwicki / demo (master) and crew1 / demo. Demo observers: see mock.observers.

import { config } from './config.js';
import { fetchAirspacesDirect } from './openaip-direct.js';
import { airspacesFromFile, loadRegionFile } from './airspaces-static.js';

const TOKEN_KEY = 's2ground.token';
const params = new URLSearchParams(location.search);
export const SIM = params.get('sim') === '1';
export const MOCK = SIM && params.get('api') !== '1';

export const DEFAULT_SETTINGS = {
  relayUrl: '',                         // '' = Worker address from config.apiBase (https → wss)
  frequencyHz: 433900000,
  riseRate: 2.5,                        // m/s, planning default
  descentRate: 5.0,                     // m/s at sea level after cutdown
  cloudRh: 92,                          // % RH threshold for the cloud band in the Stüve
  defaultFolder: '…\\Dropbox\\S2 Ground\\Aufstiege\\',
  autoLogoutH: 2,
  rr4Usb: '',                           // "VID:PID", learned on first connect
  sondeTypes: 'S2H3-R-B20 · S2H3-S-C1-B9',
  quickRepliesGround: ['Verstanden', 'Ausgelöst ✓', 'Funk schwach', 'Gelandet'],
  quickRepliesObserver: ['Bitte jetzt auslösen', 'Weiter steigen lassen', 'Daten reichen'],
  windFallbackDir: 240,                 // used when Open-Meteo is unreachable
  windFallbackSpd: 6,                   // m/s
  cutAltAgl: 3000,                      // planning default, m AGL
  openaipKey: '',                       // 'set' when stored on the Worker; the key reaches the browser only via /api/airspaces/key (see openaipDirect)
  openaipDirect: true,                  // browser fallback when openAIP refuses the Worker (master setting)
  airspaceCats: 'P,R,D,CTR,TMA',        // openAIP categories that count as a conflict
  waPhoneNumberId: '',                  // WhatsApp Cloud API (stage 2) – 'set' when stored, masked like openaipKey
  waToken: '',
};

// ---------------------------------------------------------------------------------------------
// in-memory mock backend
const DAY = 86400e3;
const mock = {
  users: [
    { name: 'bwicki', fullName: 'Balthasar Wicki', master: true, password: 'demo', active: 1, lastLogin: Date.now() - 3600e3, ascents: 14 },
    { name: 'crew1', fullName: '[Name Groundcrew]', master: false, password: 'demo', active: 1, lastLogin: Date.now() - 8 * DAY, ascents: 3 },
  ],
  observers: [
    { id: 1, code: '7K2M4Q', label: 'Command Center', displayName: 'Peter (CC)', mobile: '+41790000001', whatsapp: true, createdBy: 'bwicki', createdAt: Date.now() - 30 * DAY, revokedAt: null, lastLoginAt: Date.now() - 2 * DAY, loginCount: 6 },
    { id: 2, code: 'B8R4TZ', label: 'Crew Bergung', displayName: '', mobile: '', whatsapp: false, createdBy: 'bwicki', createdAt: Date.now() - 10 * DAY, revokedAt: null, lastLoginAt: null, loginCount: 0 },
  ],
  logins: { 1: [{ at: Date.now() - 2 * DAY, ip: '85.1.2.3', userAgent: 'Chrome/130 Android', displayName: 'Peter (CC)', ascentId: 'demo-1' }, { at: Date.now() - 9 * DAY, ip: '85.1.2.3', userAgent: 'Chrome/129 Windows', displayName: 'Peter', ascentId: null }] },
  settings: { ...DEFAULT_SETTINGS },
  log: [],
  tokens: new Map(),
  ascentSeq: 0,
};
const notifyText = (code) => `Sondenaufstieg geplant (S2 Ground)\nFolgen: https://s2stueve.wicki.aero → Follow sonde ascent · Dein Code: ${code}`;

async function mockHandle(method, path, body, token) {
  const who = mock.tokens.get(token);
  const need = (role) => { if (!who || (role === 'master' && !who.master)) throw new ApiError(403, 'forbidden'); };
  const [, seg, arg, sub] = path.match(/^\/api\/([a-z]+)(?:\/([^/?]+))?(?:\/([a-z]+))?/) || [];
  switch (`${method} ${seg}`) {
    case 'GET setup': return { needed: mock.users.length === 0 };
    case 'POST setup': {
      if (mock.users.length) throw new ApiError(409, 'exists');
      mock.users.push({ name: body.user, fullName: body.fullName || body.user, master: true, password: body.password, active: 1, lastLogin: null, ascents: 0 });
      return { ok: true };
    }
    case 'POST login': {
      const u = mock.users.find((x) => x.name === body.user && x.password === body.password && x.active);
      if (!u) throw new ApiError(401, 'bad credentials');
      const tok = 'mock-' + Math.random().toString(36).slice(2);
      mock.tokens.set(tok, u); u.lastLogin = Date.now();
      mock.log.unshift({ t: Date.now(), user: u.name, action: 'login', detail: navigator.userAgent.split(' ').pop() });
      return { token: tok, user: u.name, role: 'ground', master: u.master, lang: null };
    }
    case 'POST logout': mock.tokens.delete(token); return { ok: true };
    case 'GET me': need(); return { user: who.name, role: 'ground', master: who.master, settings: mock.settings };
    case 'GET users': need('master'); return mock.users.map(({ password, ...u }) => u);
    case 'POST users': {
      need('master');
      const ex = mock.users.find((x) => x.name === body.name);
      if (ex) Object.assign(ex, body); else mock.users.push({ active: 1, lastLogin: null, ascents: 0, master: false, ...body });
      return { ok: true };
    }
    case 'DELETE users': need('master'); mock.users = mock.users.filter((x) => x.name !== arg); return { ok: true };
    case 'GET observers': {
      need('master');
      if (arg && sub === 'logins') return mock.logins[Number(arg)] || [];
      return mock.observers;
    }
    case 'POST observers': {
      need('master');
      const o = mock.observers.find((x) => x.id === Number(arg));
      if (o && sub === 'revoke') { o.revokedAt = Date.now(); return { ok: true }; }
      if (o && sub === 'reactivate') { o.revokedAt = null; return { ok: true }; }
      if (!String(body.label || '').trim()) throw new ApiError(400, 'E_LABEL_REQUIRED');
      const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (v) => '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'[v % 32]).join('');
      const mobile = String(body.mobile || '').replace(/[\s()-]/g, '').replace(/^00/, '+');
      const n = { id: mock.observers.length + 1, code, label: body.label.trim(), displayName: '', mobile, whatsapp: !!(body.whatsapp && mobile), createdBy: who.name, createdAt: Date.now(), revokedAt: null, lastLoginAt: null, loginCount: 0 };
      mock.observers.push(n);
      return { id: n.id, code, label: n.label, mobile: n.mobile, whatsapp: n.whatsapp };
    }
    case 'PUT observers': { need('master'); const o = mock.observers.find((x) => x.id === Number(arg)); if (o) Object.assign(o, body); return { ok: true }; }
    case 'GET settings': need(); return mock.settings;
    case 'PUT settings': need('master'); Object.assign(mock.settings, body); return mock.settings;
    case 'GET log': need('master'); return mock.log.slice(0, 200);
    case 'GET airspaces': {
      need();
      if (arg === 'test') { need('master'); return { ok: true, via: 'header+ua', status: 200, count: 3, source: 'settings', keyLength: 32, keyHint: '0123…ef', keyFormatOk: true, tried: [{ via: 'header+ua', ok: true, status: 200, ms: 120, body: '' }] }; }   // demo: key test passes
      if (arg === 'key') { if (!mock.settings.openaipDirect) throw new ApiError(403, 'E_DIRECT_DISABLED'); return { key: 'demo' }; }
      const r = await fetch('./src/data/airspaces.json'); return r.json();                                  // sample data for the demo
    }
    case 'POST log': need(); mock.log.unshift({ t: Date.now(), user: who.name, action: body.action, detail: body.detail || '' }); return { ok: true };
    case 'POST ascents': {
      need();
      if (arg && sub === 'kick') return { ok: true, closed: 1 };
      mock.ascentSeq += 1;
      const notify = mock.observers.filter((o) => !o.revokedAt && o.whatsapp && o.mobile).map((o) => ({ observerId: o.id, label: o.label, mobile: o.mobile, waUrl: `https://wa.me/${o.mobile.replace(/\D/g, '')}?text=${encodeURIComponent(notifyText(o.code))}`, sent: false, error: null }));
      return { ascentId: `sim-${mock.ascentSeq}`, notify };
    }
    case 'GET ascents': need(); return [];
    default: throw new ApiError(404, 'not found');
  }
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------------------------------------
// public client
export const api = {
  mock: MOCK,
  base: (config.apiBase || '').replace(/\/$/, ''),
  token: (() => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } })(),

  setToken(tok) {
    this.token = tok;
    try { tok ? sessionStorage.setItem(TOKEN_KEY, tok) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  },

  async request(method, path, body) {
    if (MOCK) return mockHandle(method, path, body, this.token);
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || res.statusText);
    return data;
  },

  setupNeeded: () => api.request('GET', '/api/setup').then((r) => !!r.needed).catch(() => false),
  setup: (user, password, fullName) => api.request('POST', '/api/setup', { user, password, fullName }),
  login: (user, password) => api.request('POST', '/api/login', { user, password }),
  logout: () => api.request('POST', '/api/logout').catch(() => null),
  me: () => api.request('GET', '/api/me'),
  users: {
    list: () => api.request('GET', '/api/users'),
    save: (u) => api.request('POST', '/api/users', u),
    remove: (name) => api.request('DELETE', `/api/users/${encodeURIComponent(name)}`),
  },
  observers: {
    list: () => api.request('GET', '/api/observers'),
    create: (o) => api.request('POST', '/api/observers', o),
    update: (id, patch) => api.request('PUT', `/api/observers/${id}`, patch),
    revoke: (id) => api.request('POST', `/api/observers/${id}/revoke`),
    reactivate: (id) => api.request('POST', `/api/observers/${id}/reactivate`),
    logins: (id) => api.request('GET', `/api/observers/${id}/logins`),
  },
  settings: {
    get: () => api.request('GET', '/api/settings'),
    put: (s) => api.request('PUT', '/api/settings', s),
  },
  log: {
    list: (limit = 200) => api.request('GET', `/api/log?limit=${limit}`),
    add: (action, detail) => api.request('POST', '/api/log', { action, detail }).catch(() => null),
  },
  /**
   * openAIP airspaces for a bbox [w,s,e,n], three sources in order: the nightly regional export file
   * (config.airspacesUrl – the normal case), the Worker proxy (live API, key on the server) and, when openAIP
   * refuses the Worker (HTML 403 → E_OPENAIP_UNREACHABLE), the browser with the key from /api/airspaces/key
   * (logged-in ground users only, master setting openaipDirect). Sample data in mock mode.
   */
  airspaces: async (bbox) => {
    // 1) the nightly regional file (openAIP export, no key, no Worker) – whenever it covers the bbox
    if (!MOCK && config.airspacesUrl) {
      try { const r = await airspacesFromFile(bbox, config.airspacesUrl); if (r) return r; }
      catch (e) { console.warn('airspace file:', e.message); }                 // fall through to the live routes
    }
    // 2) the Worker proxy (live API, key stays on the server) – 3) the browser with the key, if allowed
    try { return await api.request('GET', `/api/airspaces?bbox=${bbox.map((v) => v.toFixed(3)).join(',')}`); }
    catch (e) {
      if (!(e instanceof ApiError) || !/^E_OPENAIP_UNREACHABLE/.test(e.message)) throw e;
      let key;
      try { ({ key } = await api.request('GET', '/api/airspaces/key')); } catch { throw e; }     // fallback off or no key → original error
      try { return await fetchAirspacesDirect(bbox, key); }
      catch (d) { throw new ApiError(d.status || 502, `${d.message}; worker: ${e.message.replace(/^E_OPENAIP_UNREACHABLE\s*/, '')}`); }
    }
  },
  /** Master only: state of the regional export file → {ok, generated, count, countries, failed} or {ok:false, message}. */
  airspacesFileTest: async () => {
    if (MOCK) return { ok: true, generated: new Date(Date.now() - 6 * 3600e3).toISOString(), count: 1234, countries: ['ch', 'de', 'at', 'fr', 'it'], failed: [] };
    try { const { meta } = await loadRegionFile(config.airspacesUrl, undefined, { force: true }); return { ok: true, ...meta }; }
    catch (e) { return { ok: false, message: e.message }; }
  },
  /** Master only: one tiny openAIP request from the browser with the key → {ok, status, count|message}. */
  airspacesDirectTest: async () => {
    if (MOCK) return { ok: true, status: 200, count: 3 };
    let key;
    try { ({ key } = await api.request('GET', '/api/airspaces/key')); } catch (e) { return { ok: false, status: e.status || 0, message: e.message }; }
    try { const r = await fetchAirspacesDirect([8.4, 47.3, 8.6, 47.5], key, undefined, { limit: 1 }); return { ok: true, status: 200, count: r.items.length }; }
    catch (d) { return { ok: false, status: d.status || 0, message: d.message }; }
  },
  /** Master only: one tiny openAIP request with the stored key → {ok, status, count | message}. */
  airspacesTest: () => api.request('GET', '/api/airspaces/test'),
  ascents: {
    create: (meta) => api.request('POST', '/api/ascents', meta),
    listActive: () => api.request('GET', '/api/ascents?active=1'),
    kick: (ascentId, observerId) => api.request('POST', `/api/ascents/${encodeURIComponent(ascentId)}/kick`, { observerId }),
  },
};
