# s2ground – internal interface contract (web app ⇄ protocol layer ⇄ worker)

Vanilla ES modules, no build step. Everything the UI needs from the hardware goes
through ONE facade: `GroundLink` (real) / `SimGroundLink` (simulation, same API).
The UI must never touch serial ports or protocol details directly.

## 1. Directory layout

```
/                         static app – GitHub Pages serves the repository ROOT of `main` (CNAME = s2ground.wicki.aero)
  index.html              single page, all phases (hash routing: #login #admin #plan #prepare #checks #ascent #retrieve #quick)
  css/app.css             design tokens from the Claude-Design boards (see docs/DESIGN.md)
  i18n/de.json, en.json   every visible string; key = dotted id; DE is the reference (tests/i18n.test.js checks key parity)
  src/config.js           apiBase = address of the Worker (workers.dev); the only thing to edit after a deploy
  src/app.js              bootstrap, routing, session (login token), phase state, "Weiter" logic
  src/api.js              Worker client (prefixes every /api path with config.apiBase) + in-memory mock (?sim=1)
  src/ui/*.js             one module per phase + header/menu/chat/map/stüve components; ui/observers.js = admin section for codes
  src/quick.js            Schnellstart logic without DOM (cutdown stepper, "hier", readiness verdict); ui/quick.js + ui/quick-live.js = the page (#quick); ui/cutdown.js = the ONE guarded CUTDOWN JETZT handler
  src/sim/*.js            simulated ascent (used when no hardware, and for tests)
  src/protocol/           **owned by the protocol task** – see §3; the UI only imports `index.js`
  src/relay.js            WebSocket client to the Worker (live telemetry fan-out + chat); URL = apiBase with https→wss
  src/files.js            writes .raw_flight_history.csv / .sounding / KML via File System Access API (fallback: download)
worker/                   Cloudflare Worker `s2ground-api` (ES module, workers.dev) – auth, users, observers, activity log, live sessions + chat
  src/index.js            router + CORS allow-list (APP_ORIGINS in wrangler.toml)
  src/auth.js, users.js, observers.js, whatsapp.js, log.js, live.js (Durable Object "LiveSession")
  schema.sql              D1 schema (users, tokens, settings, activity_log, ascents, observers, observer_logins)
  wrangler.toml
.github/workflows/tests.yml    unit tests on every push
.github/workflows/deploy.yml   Worker deploy only when worker/** changes (+ manual run with `migrate` for schema.sql/seed.sql)
docs/                     protocol spec, this file, DESIGN.md, user docs (DE/EN)
tests/                    node --test; protocol unit tests (framing, parsing, CSV writer), sim tests, worker helpers; smoke.mjs (Playwright)
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

## 3. `GroundLink` facade (src/protocol/index.js) – implemented by the protocol task

```js
export class GroundLink extends EventTarget {
  // ---- lifecycle
  static isSupported()                     // !!navigator.serial
  async connect({port} = {})               // requestPort() if none; open 38400 8N1; handshake (echo=0, mac, about); join SSP net;
                                           //   discover components; subscribe. Resolves with ReceiverInfo. Emits 'state'.
  async connect({wifi:{host, port, path, url}}) // 3.11.8 additive: transport 'wifi' = SSP over a WebSocket (spec §1.8). Binary frames
                                           //   only; the text channel is probed once (echo=0) and otherwise reported absent
                                           //   (state.textChannel=false → cutdown/exe/pairSonde reject E_NO_TEXT_CHANNEL).
                                           //   Also via options {transport:'usb'|'wifi', wifi:{…}}. Endpoint of the RR4 = open question 19.
  async disconnect()                       // unsub, close
  get state()                              // LinkState (below), always a fresh snapshot

  // ---- receiver (RR4)
  async readNet()                          // → NetSettings (frequency Hz, timeslots, slotMs, sf, bw, cr, groundSlot, sampleMs, maxData)
  async writeNet(patch)                    // text cmds + SSP set; pushes net to the S2 when reachable; read-back verify; → NetSettings
  async pairSonde()                        // "annNet"
  async gnssAidToSonde()                   // ephemeris RR4 → S2 (spec §5.7); emits 'progress'
  async readWifi()                         // 3.11.8: {enabled, ap, apSsid, apPwd, clientSsid, clientPwd, ipAddr} over SSP (E_NO_WIFI when absent)
  async writeWifi(patch)                   // 3.11.8: {mode:'off'|'client'|'ap', apSsid, apPwd, clientSsid, clientPwd} → set + wifiApply → re-read
  async syncDefaultSet()                   // 3.11.8: (re)write `sspDefaultSet` on the RR4 → true when the RR4 auto-syncs the S2 (spec §5.5a)

  // ---- sonde (S2)
  async readSonde()                        // SSP gets: name, md, mac, bat, pr, condition, power, txCriterion, net (+ params=06,13,15,17 via text) → SondeInfo
  async setCutdownAltitude(mAgl, groundPa) // relAP (text) [+ try SSP relAlt]; read-back via params=15 → number|null
  async setMode(n)                         // mode=<n>
  async ledAndWireTest()                   // wires → waits TXT R(...) ≤ 8 s → {primaryOk, secondaryOk, ledOk, battOk, raw}
  async cutdown()                          // mode=7 (S2 in flight, 3.11.8; option s2CutdownViaMode7=false → relBal) / relBal=150 (on ground)
                                           //   → RES text; later TXT C(...) emitted as 'event'
  async cutdownSecondary()                 // relGnd; 3.11.8: rejects E_CUTDOWN2_UNCONFIRMED unless the RES starts with 'C' (strictRelGnd)
  async setRole(n)                         // 3.11.8: SSP `set role` 1 reusable | 2 one-time | 3 dropsonde | 4 tethersonde
  async setLandedBehaviour(n)              // findme=<0|1|2> (2 = continue sounding, 3.11.8)
  async beep()                             // beep=2900
  async sendExe(text, {timeoutMs=8000})    // generic <id>.exe=…  → RES text (one at a time, queued, ≥1 s spacing)

  // ---- session / telemetry
  startSession({groundAlt, groundPa, meta}) // from now on 'telemetry' events carry alt/altAgl; MET history expanded to INF records
  stopSession()
  // events (CustomEvent.detail):
  //   'state'      LinkState
  //   'telemetry'  TelemetryRecord
  //   'packet'     {rssi, rs, snr, rec, t}            (PK)
  //   'event'      {type:'cutdown'|'wireHeated'|'wireTest'|'announce'|'timeout'|'gnssIntegrity', data, raw}
  //                gnssIntegrity (3.11.8, flag gnssIntegrityEvents): data {jam, spoof (0/1/2), jamming, spoofing:'none'|'suspected'|'detected'}
  //   'line'       {dir:'rx'|'tx', text, t}           (raw protocol log for the expert view / .sounding)
  //   'error'      Error
}

/** LinkState: {
 *   port: 'closed'|'opening'|'open'|'lost',
 *   transport: 'usb'|'wifi', textChannel: boolean|null,          // 3.11.8: text channel usable? (null while closed)
 *   wifi: null | WifiSettings, autoSync: null|false|{schema, written},  // 3.11.8: last readWifi(); RR4 sspDefaultSet support
 *   receiver: null | {hw, fw, prot, mac, componentId, gnssFix:boolean|null, batV:number|null, tempC:number|null, utcSyncSource},
 *   sonde:    null | SondeInfo,
 *   net:      null | NetSettings,
 *   lastRxT:  number|null, rxLines:number, txLines:number
 * }
 *  SondeInfo: {id (number), name, componentId, type:string|null ('S2H3-R-B20'…; null if not readable), md, batV, pr, condition (bitmap),
 *              conditionText:string[], powerDbm, powerBeforeLaunchDbm, txCriterion, fwver, cutAltAgl, role, jam, spoof}
 *  TelemetryRecord additionally carries jam, spoof (3.11.8; null when the sonde does not send them).
 *  writeNet rejects E_FREQ_RANGE when frequencyHz lies outside options.freqRange ('default' 400–440 MHz, 'extended' 390–440 MHz, {minHz,maxHz}).
 */
export class SimGroundLink extends GroundLink { /* same API, scripted ascent, no serial; options {speed} */ }
export { parseBracketLine, encodeFrame, decodeFrame } // for tests
```

Rules for the protocol task: everything per docs/protocol/ssp-windsond-protocol.md; line classifier per §1.2;
text channel first (proven), SSP for net/status/gnss; every uncertain item ([I]/[U]) behind a clearly
named option or feature flag with a TODO referencing the spec's open question number; never block the UI
(all methods async with timeouts); keep a ring buffer of the last 2000 raw lines.

## 4. Worker API (used by src/app.js, src/relay.js and s2stueve "Follow")

All JSON, `Authorization: Bearer <token>`. Base URL = `config.apiBase` (https://s2ground-api.balthasar.workers.dev).
CORS: only the origins in `APP_ORIGINS` (wrangler.toml) may call the API from a browser.

**Access model** – two kinds of principals, no other roles:

| Principal | How they get a token | `auth` on the server | may |
|---|---|---|---|
| Ground user | `POST /api/login` {user, password} | `{user, role:'ground', master:true/false}` | everything in the ground app: ascents, hardware actions, chat, kick; `master` additionally users / observers / settings / log |
| Observer (Beobachter) | `POST /api/observer/login` {code, displayName} | `{user:<displayName>, role:'observer', observerId}` | read active ascents, join the live channel, read everything, write in the chat (instructions like «Bitte jetzt auslösen»). Never telemetry/state/event, never hardware. |

`requireRole(auth)` = any principal · `requireRole(auth,'ground')` = any ground user · `requireRole(auth,'master')` = master flag · `requireRole(auth,'observer')` = observer token.
Observer codes: 6 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no 0/O/1/I), permanent, stored in plain text (viewing codes, not secrets), revocable; revoking deletes the observer's tokens immediately.

| Method | Path | Who | Body / result |
|---|---|---|---|
| GET  | /api/health | – | {ok, t} |
| GET/POST | /api/setup | – | {needed} / {user, password, fullName} → first user = master (only while the users table is empty) |
| POST | /api/login | – | {user, password} → {token, user, role:'ground', master, lang} (rate-limited per IP) |
| POST | /api/observer/login | – | {code, displayName} → {token, role:'observer', displayName, observerId, label}; 403 `E_CODE_UNKNOWN` / `E_CODE_REVOKED`, 400 `E_NAME_REQUIRED`; rate-limited; writes observer_logins (IP, UA, name, active ascent) |
| POST | /api/logout | any | — |
| GET  | /api/me | any | ground: {user, role, master, settings} · observer: {user, role, observerId} |
| GET/POST/DELETE | /api/users[/:name] | master | users: {name, fullName, master, active, lastLogin, ascents}; POST {name, fullName, password?, master?, active?} (cannot deactivate yourself / drop your own master flag) |
| GET  | /api/observers | master | [{id, code, label, displayName, mobile, whatsapp, createdBy, createdAt, revokedAt, lastLoginAt, loginCount}] |
| POST | /api/observers | master | {label, mobile (E.164 or ''), whatsapp} → {id, code, label, mobile, whatsapp} – the code is created here and also listed later |
| PUT  | /api/observers/:id | master | {label?, mobile?, whatsapp?} |
| POST | /api/observers/:id/revoke · /reactivate | master | — |
| GET  | /api/observers/:id/logins | master | [{at, ip, userAgent, displayName, ascentId}] newest first |
| GET/PUT | /api/settings | ground / master writes | app settings (relay url, default frequency, rise rate, default cutdown AGL, cloud RH threshold, default folder, auto-logout h, RR4 usb ids, quick replies, airspace categories). Secrets `openaipKey`, `waPhoneNumberId`, `waToken` are returned masked as 'set' / '' and kept when echoed back |
| GET  | /api/log?limit= | master | activity log |
| POST | /api/log | any | {action, detail} – every login/phase step/command is logged client-side too |
| GET  | /api/airspaces?bbox=w,s,e,n | ground | openAIP airspaces via the Worker (key from settings.openaipKey). Three honest request variants are tried in turn – header only, header + `apiKey` query, + User-Agent `s2ground/1.0` – and the answer carries `via`. Errors: 409 `E_NO_OPENAIP_KEY`, 409 `E_OPENAIP_KEY_REJECTED (…)` when the API itself answers JSON 401/403, 502 `E_OPENAIP_UNREACHABLE (variant status: answer; …)` for gateway blocks (HTML 403) or network errors – the bracket lists every attempt |
| GET  | /api/airspaces/test | master | one tiny openAIP request with the stored key → `{ok:true,via,status,count,keyLength,tried[]}` or `{ok:false,status,message,tried[]}` where `tried[]` = `{via,ok,status,ms,body}` per variant (never throws); the admin page calls it after a key is saved and on «openAIP-Schlüssel testen» and shows the per-variant report in the toast |
| POST | /api/ascents | ground | {name, start:{name,lat,lon,alt}, plannedLaunch (ms), cutAltAgl, frequencyHz, sondeId} → {ascentId, notify:[{observerId, label, mobile, waUrl, sent, error}]} – one entry per active observer with mobile + whatsapp; `waUrl` = https://wa.me/<digits>?text=<standard message> (stage 1); `sent:true` when the Cloud API sent it (stage 2) |
| GET  | /api/ascents?active=1 | any (observers too) | [{id, name, owner, createdAt, active, meta}] – s2stueve "Follow sonde ascent" picks the newest |
| POST | /api/ascents/:id/close | ground | — |
| POST | /api/ascents/:id/kick | ground | {observerId} → DO closes that observer's sockets (code 4001) and blocks the id for this ascent → {ok, closed} |
| WS   | /live/:ascentId?token=… | any | WebSocket to the Durable Object; the token decides the role (no `role`/`code` query any more). Ground sends {type:'telemetry'|'state'|'event'}; the DO **drops those types from observer sockets**; everyone receives them; chat {type:'chat', text} from anyone; presence {type:'presence', users:[{name, role:'ground'|'observer', observerId, since}]} where `name` is the observer's Klarname; join replay {type:'history', records, chat, state, closed} |

**WhatsApp notification** (`worker/src/whatsapp.js`): the standard message (DE) is built on the server from the ascent meta:
`Sondenaufstieg geplant (S2 Ground)` · `Start: 17.10.2026 14:30 LT` · `Startort: Rümlang · 4727N00834E` · `Cutdown: 3'000 m AGL` · `Frequenz: 433.900 MHz` · `Sonde: 12345` · `Folgen: https://s2stueve.wicki.aero → Follow sonde ascent · Dein Code: XXXXXX`.
Stage 1 (works today): the Prepare page shows one wa.me button per observer; tapping is logged (`notify.whatsapp`).
Stage 2 (prepared, not released): `sendWhatsApp(env, settings, to, text)` posts to the Meta Cloud API when `waPhoneNumberId` + `waToken` are set; createAscent then sends automatically and returns `notify[].sent=true`.

Durable Object `LiveSession`: keeps the full telemetry history of the ascent in memory + storage so a late
observer gets the whole profile on join (`{type:'history', records:[…]}`), keeps the last 200 chat messages,
presence and the kick list (`blocked`, persisted) of the ascent. The ground app never applies incoming
telemetry/state/event from the relay – it is the source of truth.

## 5. UI contract (src/app.js)

* Phases: plan → prepare → checks → ascent → retrieve (ids `plan|prepare|checks|ascent|retrieve`), status per phase `ok|warn|bad|todo`.
* "Weiter" always in the action bar at the top; if the phase is not ok → confirm dialog ("Trotzdem weiter?") and the phase chip turns yellow/red.
* Expert content lives in the header hamburger menu (`<details class="menu">`), per phase.
* Language toggle DE/EN (persist in localStorage, key `s2ground.lang`); all strings through `t('key')`.
* Number formatting: thousands separator `'` (de-CH), units never wrap, coordinates ICAO (DDMMN DDDMME and with seconds), altitudes AMSL/AGL.
* Login like ops.wicki.aero: user + password → Worker; token in sessionStorage; auto-logout after the configured hours.
* Mock/Sim mode: `?sim=1` or when Web Serial is unsupported → `SimGroundLink`; banner "Simulation".
* **Schnellstart** (`#quick`, "Sonde sofort hier starten"): a second entry besides the phase flow, no planning. Login page and plan page action bar offer it; the page has a minimal header (no phase bar) and a link "Stattdessen vollständig planen →" (`#plan`). Pre-start: three steps (Verbinden / Einstellen / Starten); start = "hier" (receiver GPS → device GPS → default start, ICAO + m AMSL), cutdown altitude in 500 m steps (500…12'000 m AGL, default `settings.cutAltAgl`), airspace check automatic via `runPlan` (start = here, launch = now), then ONE button "SONDE PROGRAMMIEREN & FREIGEBEN" = `programSonde` → `link.ledAndWireTest()` → wait until `startVerdict()` (src/quick.js) is green → release (same logging as the checks page). Launch detection of app.js then switches the page to the live state (banner, three tiles, CUTDOWN JETZT, retrieval block after landing). The ascent state, files, relay, observers and activity log are exactly those of the phase flow (`ctx.log('quickstart', …)` once at the start); "Vollständige Ansicht →" opens `#ascent` for the same ascent. Observers are notified only via the link at the bottom (`notify.whatsapp`), never automatically.
