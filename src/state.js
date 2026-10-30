// Central application state + a tiny event bus. Views read `state` and subscribe to `bus`.
// Nothing here touches the DOM; the sim and tests can drive it headless.

export const PHASES = ['plan', 'prepare', 'checks', 'ascent', 'retrieve'];

class Bus extends EventTarget {
  on(type, fn) { const h = (e) => fn(e.detail); this.addEventListener(type, h); return () => this.removeEventListener(type, h); }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
export const bus = new Bus();

export const state = {
  session: null,                 // {user, role:'ground', master:boolean, settings, loginAt, lastActivity} – observers never log in here
  sim: false,
  phase: 'plan',
  phaseStatus: Object.fromEntries(PHASES.map((p) => [p, { level: 'todo', summary: '' }])),
  overridden: {},                // phase → true when the user chose "Trotzdem weiter"
  visited: { plan: true },

  plan: {
    start: { lat: 47.4433, lon: 8.5617, alt: 432, name: 'CH-Rümlang', source: 'rr4' },   // places are always «CC-Ort»
    date: null, time: null, tz: 'LT',     // filled by the plan view (now, rounded to 10 min)
    cutdownMode: 'alt', cutAltAgl: 3000, noCutdownConfirmed: false,   // default 3'000 m AGL (settings.cutAltAgl overrides); the demo's sample LS-R12 starts at 2'100 m → warning flow
    opMode: 'ascent',
    balloonType: 'Latex 9 g (Standard)', gas: 'Ballongas (Linde)',
    balloonG: 9, payloadG: 14, riseRate: 2.5, descentRate: 5.0, model: 'Best match',
    showAirspace: true, ignoreAirspace: false,
    result: null,                // planning.predict() output
    windSource: null,            // 'open-meteo' | 'fallback'
  },

  link: null,                    // GroundLink / SimGroundLink
  linkState: { port: 'closed', receiver: null, sonde: null, net: null, lastRxT: null, rxLines: 0, txLines: 0 },
  telemetry: [],                 // TelemetryRecord[] since startSession
  last: null,                    // last TelemetryRecord
  packets: { rx: 0, lost: 0, lastT: null, rs: null, snr: null },
  launch: null,                  // {index, t, alt} once the launch is detected (spec §6.2)
  peak: null,                    // {alt, t}
  cutdown: null,                 // {t, alt, by:'auto'|'manual'}
  landed: null,                  // {t, lat, lon, alt}
  lostInDescent: false,          // no packet for > 60 s while falling → estimated landing
  events: [],                    // link events (wireTest, cutdown, …)
  lines: [],                     // raw protocol lines (ring buffer for the expert view)

  balloonConfirmed: false,
  wireTest: null,                // result of ledAndWireTest()
  sondeWritten: null,            // values read back from the sonde after programming
  released: false,               // "START FREIGEBEN" pressed (by hand in the checks, automatically in the quick start)
  quick: null,                   // Schnellstart (ui/quick.js): {run:'idle'|'working'|'waiting'|'failed', frozen, error, …}; null = not used in this ascent
  checksSince: null,             // clock time the checks started (the "seit …" hint of the GPS check)

  ascent: null,                  // {ascentId, name, startedAt, notify:[{observerId,label,mobile,waUrl,sent}]}
  relay: { connected: false, sent: 0, errors: 0, presence: [], chat: [] },   // presence: [{name, role:'ground'|'observer', observerId, since}]
  files: { folder: null, supported: false, rows: 0 },
  device: null,                  // {lat, lon, acc} from navigator.geolocation
};

/** Current time: the link's clock when it has one (the simulation runs faster than wall-clock). */
export function now() { const l = state.link; return l && typeof l.now === 'function' ? l.now() : Date.now(); }

export function settings() { return (state.session && state.session.settings) || {}; }

/** Set a phase's status (level ok|warn|bad|todo + short summary for the action bar). */
/**
 * acknowledged = the user already took a conscious decision about this state (e.g. «Warnung ignorieren»);
 * the phase stays yellow in the bar, but «Weiter» does not ask a second time.
 */
export function setPhaseStatus(phase, level, summary, acknowledged = false) {
  const cur = state.phaseStatus[phase];
  if (cur.level === level && cur.summary === summary && !!cur.acknowledged === acknowledged) return;
  state.phaseStatus[phase] = { level, summary, acknowledged };
  bus.emit('phase', { phase, level, summary, acknowledged });
}

export function addLine(line) {
  state.lines.push(line);
  if (state.lines.length > 2000) state.lines.splice(0, state.lines.length - 2000);
  bus.emit('line', line);
}

/** Reset everything that belongs to one ascent (called when an ascent is archived). */
export function resetAscent() {
  Object.assign(state, {
    telemetry: [], last: null, packets: { rx: 0, lost: 0, lastT: null, rs: null, snr: null },
    launch: null, peak: null, cutdown: null, landed: null, lostInDescent: false, events: [],
    balloonConfirmed: false, wireTest: null, sondeWritten: null, released: false, ascent: null, quick: null, checksSince: null,
    overridden: {}, visited: { plan: true },
  });
  state.plan.result = null; state.plan.ignoreAirspace = false;
  for (const p of PHASES) state.phaseStatus[p] = { level: 'todo', summary: '' };
  state.relay.chat = [];
  // app.js turns `sent`/`errors` into getter-only properties while a relay is open → plain assignment would throw (TypeError) and abort the archiving
  for (const k of ['sent', 'errors']) Object.defineProperty(state.relay, k, { value: 0, writable: true, enumerable: true, configurable: true });
  state.files.rows = 0;
  bus.emit('reset');
}
