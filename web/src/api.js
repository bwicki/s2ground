// Worker API client (docs/INTERFACE.md §4) with a built-in mock.
// Mock mode (?sim=1 without ?api=1, or when the page is opened from a file/static host) keeps
// users, settings and the activity log in memory so the whole app runs without the Worker.
// Demo master user: bwicki / demo. Also crew1 / demo (ground) and cc / demo (command).

const TOKEN_KEY = 's2ground.token';
const params = new URLSearchParams(location.search);
export const SIM = params.get('sim') === '1';
export const MOCK = SIM && params.get('api') !== '1';

export const DEFAULT_SETTINGS = {
  relayUrl: '',                         // '' = same origin (wss://s2ground.wicki.aero/live/…)
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
  openaipKey: '',                       // 'set' when stored on the Worker; the key itself never reaches the browser
  airspaceCats: 'P,R,D,CTR,TMA',        // openAIP categories that count as a conflict
};

// ---------------------------------------------------------------------------------------------
// in-memory mock backend
const mock = {
  users: [
    { name: 'bwicki', fullName: 'Balthasar Wicki', role: 'master', password: 'demo', active: 1, lastLogin: Date.now() - 3600e3, ascents: 14 },
    { name: 'crew1', fullName: '[Name Groundcrew]', role: 'ground', password: 'demo', active: 1, lastLogin: Date.now() - 8 * 86400e3, ascents: 3 },
    { name: 'cc', fullName: '[Name Command Center]', role: 'command', password: 'demo', active: 1, lastLogin: Date.now() - 8 * 86400e3, ascents: 0 },
    { name: 'gast', fullName: '[Gast]', role: 'observer', password: 'demo', active: 0, lastLogin: null, ascents: 0 },
  ],
  settings: { ...DEFAULT_SETTINGS },
  log: [],
  tokens: new Map(),
  ascentSeq: 0,
};

async function mockHandle(method, path, body, token) {
  const who = mock.tokens.get(token);
  const need = (role) => { if (!who || (role && who.role !== role)) throw new ApiError(403, 'forbidden'); };
  const [, seg, arg] = path.match(/^\/api\/([a-z]+)(?:\/([^/?]+))?/) || [];
  switch (`${method} ${seg}`) {
    case 'GET setup': return { needed: mock.users.length === 0 };
    case 'POST setup': {
      if (mock.users.length) throw new ApiError(409, 'exists');
      mock.users.push({ name: body.user, fullName: body.fullName || body.user, role: 'master', password: body.password, active: 1, lastLogin: null, ascents: 0 });
      return { ok: true };
    }
    case 'POST login': {
      const u = mock.users.find((x) => x.name === body.user && x.password === body.password && x.active);
      if (!u) throw new ApiError(401, 'bad credentials');
      const tok = 'mock-' + Math.random().toString(36).slice(2);
      mock.tokens.set(tok, u); u.lastLogin = Date.now();
      mock.log.unshift({ t: Date.now(), user: u.name, action: 'login', detail: navigator.userAgent.split(' ').pop() });
      return { token: tok, user: u.name, role: u.role, lang: null };
    }
    case 'POST logout': mock.tokens.delete(token); return { ok: true };
    case 'GET me': need(); return { user: who.name, role: who.role, settings: mock.settings };
    case 'GET users': need('master'); return mock.users.map(({ password, ...u }) => u);
    case 'POST users': {
      need('master');
      const ex = mock.users.find((x) => x.name === body.name);
      if (ex) Object.assign(ex, body); else mock.users.push({ active: 1, lastLogin: null, ascents: 0, role: 'ground', ...body });
      return { ok: true };
    }
    case 'DELETE users': need('master'); mock.users = mock.users.filter((x) => x.name !== arg); return { ok: true };
    case 'GET settings': need(); return mock.settings;
    case 'PUT settings': need('master'); Object.assign(mock.settings, body); return mock.settings;
    case 'GET log': need('master'); return mock.log.slice(0, 200);
    case 'GET airspaces': { need(); const r = await fetch('./src/data/airspaces.json'); return r.json(); }   // sample data for the demo
    case 'POST log': need(); mock.log.unshift({ t: Date.now(), user: who.name, action: body.action, detail: body.detail || '' }); return { ok: true };
    case 'POST ascents': {
      need(); mock.ascentSeq += 1;
      return { ascentId: `sim-${mock.ascentSeq}`, followCode: '7K2-M4Q' };
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
  token: (() => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } })(),

  setToken(tok) {
    this.token = tok;
    try { tok ? sessionStorage.setItem(TOKEN_KEY, tok) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  },

  async request(method, path, body) {
    if (MOCK) return mockHandle(method, path, body, this.token);
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
  settings: {
    get: () => api.request('GET', '/api/settings'),
    put: (s) => api.request('PUT', '/api/settings', s),
  },
  log: {
    list: (limit = 200) => api.request('GET', `/api/log?limit=${limit}`),
    add: (action, detail) => api.request('POST', '/api/log', { action, detail }).catch(() => null),
  },
  /** openAIP airspaces for a bbox [w,s,e,n] via the Worker proxy (sample data in mock mode). */
  airspaces: (bbox) => api.request('GET', `/api/airspaces?bbox=${bbox.map((v) => v.toFixed(3)).join(',')}`),
  ascents: {
    create: (meta) => api.request('POST', '/api/ascents', meta),
    listActive: () => api.request('GET', '/api/ascents?active=1'),
  },
};
