# s2ground – internal interface contract (web app ⇄ protocol layer ⇄ worker)

Vanilla ES modules, no build step. Everything the UI needs from the hardware goes
through ONE facade: `GroundLink` (real) / `SimGroundLink` (simulation, same API).
The UI must never touch serial ports or protocol details directly.

## 1. Directory layout

```
web/                      static app (served by the Worker's assets binding, or any static host)
  index.html              single page, all phases (hash routing: #login #admin #plan #prepare #checks #ascent #retrieve)
  css/app.css             design tokens from the Claude-Design boards (see docs/DESIGN.md)
  i18n/de.json, en.json   every visible string; key = dotted id; DE is the reference
  src/app.js              bootstrap, routing, session (login token), phase state, "Weiter" logic
  src/ui/*.js             one module per phase + header/menu/chat/map/stüve components
  src/sim/*.js            simulated ascent (used when no hardware, and for tests)
  src/protocol/           **owned by the protocol task** – see §3; the UI only imports `index.js`
  src/relay.js            WebSocket client to the Worker (live telemetry fan-out + chat)
  src/files.js            writes .raw_flight_history.csv / .sounding / KML via File System Access API (fallback: download)
worker/                   Cloudflare Worker (ES module) – auth, users/roles, activity log, live sessions + chat
  src/index.js
  src/auth.js, users.js, log.js, live.js (Durable Object "LiveSession")
  schema.sql              D1 schema (users, activity_log, ascents)
  wrangler.toml
.github/workflows/deploy.yml   deploy on push to main with secret CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID)
docs/                     protocol spec, this file, DESIGN.md, user docs (DE/EN)
tests/                    node --test; protocol unit tests (framing, parsing, CSV writer), sim tests
```

## 2. Unified telemetry record (what the UI, files, relay and s2stueve consume)

```js
/** @typedef {Object} TelemetryRecord
 *  t          : number   // ms since epoch (PC clock at receive), always set
 *  sondeId    : number   // sonde number (MAC)
 *  seq        : number|null
 *  src        : 'DAT'|'MET'|'INF'|'SIM'
 *  md         : number|'A'|null   // sonde mode, see spec §6.1
 *  lat, lon   : number|null       // WGS-84 deg
 *  gpsAlt     : number|null       // m MSL from GNSS
 *  pa         : number|null       // pressure Pa
 *  alt        : number|null       // pressure altitude m AMSL (computed; = gpsAlt if no barometer)
 *  altAgl     : number|null       // alt − groundAlt
 *  te         : number|null       // °C   (wrap >400 → −655.36 applied)
 *  hu         : number|null       // % RH
 *  td         : number|null       // °C dew point (Magnus, computed)
 *  spd        : number|null       // m/s ground speed  (wind proxy)
 *  ang        : number|null       // ° true course     (wind proxy)
 *  rise       : number|null       // m/s
 *  su         : number|null       // V battery
 *  rssi       : number|null       // 0..1 normalised (spec §5.10)
 *  rs, snr    : number|null       // dBm / dB when present (RR4)
 *  rec        : number|null
 *  sats       : number|null
 *  raw        : string            // the original bracket line (for .sounding)
 * }
 */
```

## 3. `GroundLink` facade (web/src/protocol/index.js) – implemented by the protocol task

```js
export class GroundLink extends EventTarget {
  // ---- lifecycle
  static isSupported()                     // !!navigator.serial
  async connect({port} = {})               // requestPort() if none; open 38400 8N1; handshake (echo=0, mac, about); join SSP net;
                                           //   discover components; subscribe. Resolves with ReceiverInfo. Emits 'state'.
  async disconnect()                       // unsub, close
  get state()                              // LinkState (below), always a fresh snapshot

  // ---- receiver (RR4)
  async readNet()                          // → NetSettings (frequency Hz, timeslots, slotMs, sf, bw, cr, groundSlot, sampleMs, maxData)
  async writeNet(patch)                    // text cmds + SSP set; pushes net to the S2 when reachable; read-back verify; → NetSettings
  async pairSonde()                        // "annNet"
  async gnssAidToSonde()                   // ephemeris RR4 → S2 (spec §5.7); emits 'progress'

  // ---- sonde (S2)
  async readSonde()                        // SSP gets: name, md, mac, bat, pr, condition, power, txCriterion, net (+ params=06,13,15,17 via text) → SondeInfo
  async setCutdownAltitude(mAgl, groundPa) // relAP (text) [+ try SSP relAlt]; read-back via params=15 → number|null
  async setMode(n)                         // mode=<n>
  async ledAndWireTest()                   // wires → waits TXT R(...) ≤ 8 s → {primaryOk, secondaryOk, ledOk, battOk, raw}
  async cutdown()                          // relBal (in flight) / relBal=150 (on ground) → RES text; later TXT C(...) emitted as 'event'
  async cutdownSecondary()                 // relGnd
  async beep()                             // beep=2900
  async sendExe(text, {timeoutMs=8000})    // generic <id>.exe=…  → RES text (one at a time, queued, ≥1 s spacing)

  // ---- session / telemetry
  startSession({groundAlt, groundPa, meta}) // from now on 'telemetry' events carry alt/altAgl; MET history expanded to INF records
  stopSession()
  // events (CustomEvent.detail):
  //   'state'      LinkState
  //   'telemetry'  TelemetryRecord
  //   'packet'     {rssi, rs, snr, rec, t}            (PK)
  //   'event'      {type:'cutdown'|'wireHeated'|'wireTest'|'announce'|'timeout', data, raw}
  //   'line'       {dir:'rx'|'tx', text, t}           (raw protocol log for the expert view / .sounding)
  //   'error'      Error
}

/** LinkState: {
 *   port: 'closed'|'opening'|'open'|'lost',
 *   receiver: null | {hw, fw, prot, mac, componentId, gnssFix:boolean|null, batV:number|null, tempC:number|null, utcSyncSource},
 *   sonde:    null | SondeInfo,
 *   net:      null | NetSettings,
 *   lastRxT:  number|null, rxLines:number, txLines:number
 * }
 *  SondeInfo: {id (number), name, componentId, type:string|null ('S2H3-R-B20'…; null if not readable), md, batV, pr, condition (bitmap),
 *              conditionText:string[], powerDbm, powerBeforeLaunchDbm, txCriterion, fwver, cutAltAgl, role}
 */
export class SimGroundLink extends GroundLink { /* same API, scripted ascent, no serial; options {speed} */ }
export { parseBracketLine, encodeFrame, decodeFrame } // for tests
```

Rules for the protocol task: everything per docs/protocol/ssp-windsond-protocol.md; line classifier per §1.2;
text channel first (proven), SSP for net/status/gnss; every uncertain item ([I]/[U]) behind a clearly
named option or feature flag with a TODO referencing the spec's open question number; never block the UI
(all methods async with timeouts); keep a ring buffer of the last 2000 raw lines.

## 4. Worker API (used by web/src/app.js and web/src/relay.js)

All JSON, `Authorization: Bearer <token>`; tokens from `/api/login`. Roles: `master`, `ground`, `command`, `observer`, `guest`.

| Method | Path | Body / result |
|---|---|---|
| POST | /api/login | {user, password} → {token, user, role, lang} |
| POST | /api/logout | — |
| GET  | /api/me | → {user, role, settings} |
| GET/POST/DELETE | /api/users[/:name] | master only |
| GET/PUT | /api/settings | app settings (relay url, default frequency, rise rate, default cutdown AGL, cloud RH threshold, default folder, auto-logout h, RR4 usb ids, quick replies, airspace categories, openAIP key – returned masked as 'set') – master writes |
| GET  | /api/log?limit= | activity log (master) |
| GET  | /api/airspaces?bbox=w,s,e,n | openAIP airspaces (items: _id, name, type, icaoClass, lowerLimit, upperLimit, geometry) via the Worker; key from settings.openaipKey (server-side only); cached 24 h per 0.2° cell; 409 E_NO_OPENAIP_KEY / E_OPENAIP_KEY_REJECTED, 502 E_OPENAIP_UNREACHABLE |
| POST | /api/log | {action, detail} – every login/phase step/command is logged client-side too |
| POST | /api/ascents | create live session → {ascentId, followCode} |
| GET  | /api/ascents?active=1 | list (for s2stueve "Follow sonde ascent") |
| WS   | /live/:ascentId?token=…&role=… | WebSocket to Durable Object: ground sends {type:'telemetry'|'state'|'event'}, everyone receives them; chat {type:'chat', text}; presence {type:'presence', users:[{name, role, since}]}; guest join with {code} |

Durable Object `LiveSession`: keeps the full telemetry history of the ascent in memory + storage so a late
observer gets the whole profile on join (`{type:'history', records:[…]}`), keeps the last 200 chat messages.

## 5. UI contract (web/src/app.js)

* Phases: plan → prepare → checks → ascent → retrieve (ids `plan|prepare|checks|ascent|retrieve`), status per phase `ok|warn|bad|todo`.
* "Weiter" always in the action bar at the top; if the phase is not ok → confirm dialog ("Trotzdem weiter?") and the phase chip turns yellow/red.
* Expert content lives in the header hamburger menu (`<details class="menu">`), per phase.
* Language toggle DE/EN (persist in localStorage, key `s2ground.lang`); all strings through `t('key')`.
* Number formatting: thousands separator `'` (de-CH), units never wrap, coordinates ICAO (DDMMN DDDMME and with seconds), altitudes AMSL/AGL.
* Login like ops.wicki.aero: user + password → Worker; token in sessionStorage; auto-logout after the configured hours.
* Mock/Sim mode: `?sim=1` or when Web Serial is unsupported → `SimGroundLink`; banner "Simulation".
