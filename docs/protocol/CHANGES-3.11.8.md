# Delta analysis: Windsond Desktop 3.8.0 → 3.11.8 (RR4 / S2 interface)

Companion to `ssp-windsond-protocol.md` (now at revision "3.11.8"). Same legal frame: an interoperability
description in our own words (Swiss URG Art. 21 / EU 2009/24/EC); no vendor code, no licence
material, no service tokens. Confidence marks as in the main document: **[C]** confirmed from constants /
control flow, **[I]** inferred, **[U]** unknown (hardware test needed).

Material: release notes 3.8.1 … 3.11.8, the 3.11.8 bytecode (decompile + disassembly where the
decompile was incomplete), the 3.11.8 ontology (now a Python package `ssp_ontology` instead of the
`ontology/*.txt` files), the shipped static templates; compared constant-by-constant against 3.8.0.

---

## 1. Summary table

| Area | 3.8.0 | 3.11.8 | Impact on S2 Ground |
|---|---|---|---|
| USB serial transport (§1.1) | 38400 8N1, line protocols | unchanged (38400 still used by the application; the RR4 is a native-USB CDC device, VID `303a` PID `1001`, so the baud rate is nominal) [C] | none; `usb` filter may use 303a:1001 (and 303a:80d3 seen in the WiFi tool) |
| `about` parsing (§5.1) | line must start with `Sparv RR4 ` | any line containing `RR4` is accepted; `prot=` value ends at `,`, space or end; missing `prot=` → treated as protocol 5/6 [C] | `parseAbout` already tolerant; keep |
| SSP line/hex framing (§1.2, §1.4) | — | unchanged [C] | none |
| SSP message codes (§2.1) | 4,5,6,7,8,11,14,15,16,17,18,19,20,30,31,32, +0x80 forms 142–149, 154 | identical [C] | none |
| CInfo `compatibility` (§2.2) | 1 | **3** (bit0 "understands newidWithRev", bit1 "working get values") [C] | send 3 (done, option `compat`) |
| Type registry (§3.3) | REF ≤ 114 | **+115 Int32Fix1e6, +116 Uint64AndNameMap (Tuple U64, NameMap), +117 Uint32AndString, +118 ListOfStrings**; nothing renamed/removed [C] | added to `REGISTRY` |
| Symbol table (§4) | 489 symbols | **+24 symbols**, none removed/renumbered [C] (list in §3 below) | `symbols.json` extended |
| RR4 ↔ S2 settings sync (§5.5) | PC pushes `net`, `txCriterion`, `power_dBm`, `powerBeforeLaunch_dBm`, `encKey` to the S2 itself | **new RR4 variable `sspDefaultSet` (477, REF116)**: when present, the PC writes the desired S2 settings once to the RR4 and the RR4 syncs any S2 it sees; the PC pushes to the S2 only when the RR4 lacks the variable [C] | implemented behind `rr4AutoSync` (default on; falls back to the old push) |
| S2 object subscription (§4.3, §5.3) | gnssEnabled, md, mac, bat, net, condition, pr, txCriterion, power_dBm, powerBeforeLaunch_dBm | **+ `role` (1109)**; `encUnlocked`/`encKey` in a separate encryption view [C] | `role` subscribed; new `setRole()` |
| S2 role change | not possible | `set role` over SSP: 1 reusable, 2 one-time, 3 dropsonde, **4 tethersonde (new)**; 3 attempts × 1 s [C] | `GroundLink.setRole(n)` (additive) |
| Manual cut-down of an S2 (§5.8) | `relBal` in flight, `relBal=150` on the ground | **`mode=7` in flight** for an S2 (3.9.0 "cut-down now delay" fix); `relBal=150` on the ground unchanged; `relBal` only for non-S2 firmware ≥ 170 [C] | `cutdown()` sends `mode=7` for S2 (option `s2CutdownViaMode7`, default on) |
| Secondary cut-down (§5.8) | `relGnd`, any RES accepted | `relGnd`; RES is "confirmed" only when it **starts with `C`** (a cut-down report), otherwise "invalid response" (3.11.7) [C] | `cutdownSecondary()` rejects `E_CUTDOWN2_UNCONFIRMED` unless the RES starts with `C` (option `strictRelGnd`) |
| Behaviour after landing (`behlan`, text `findme=`) | 0 power-save, 1 beacon at once | **+2 "continue sounding"** (3.8.7) [C] | `setLandedBehaviour(n)` 0/1/2 (additive) |
| Radio quality keys (§5.10) | `rs`, `snr` integers | **`rs`, `snr` parsed as floats** (3.11.3); `rssi`/`q`/`rec` logic unchanged [C] | parser accepts decimals for every numeric key |
| GNSS spoofing / jamming (§5.10) | — | **new integer keys `jam`, `spoof`** in DAT/MET (0 none, 1 possible, 2 detected [I]); PC-side `sw_spoof` from pressure vs GNSS altitude [C] | `TelemetryRecord.jam/spoof`, event `gnssIntegrity` (feature flag `gnssIntegrityEvents`) |
| Dropsonde detection (§6.2) | role from config | **dynamic**: `role` param of the sonde (via `params=06`) decides; capability letter `O` = one-time; config default as fallback (3.9.0) [C] | `SondeInfo.role` already from telemetry; nothing to send |
| Frequency limits (§5.4) | software rejects outside 400–450 MHz; GUI 400–440 (390–440 "wide") | allowed span is a configuration: **default 400–440 MHz, extended 390–440 MHz**; 3.10.1 fixed 390–400 MHz; 3.11.7 can narrow it per licence [C for the spans, licence mechanism deliberately not described] | `writeNet` validates against `freqRange` (default 400–440, `extended` 390–440) → `E_FREQ_RANGE` |
| Radio settings during a sounding | fields disabled while a sounding runs | editable (GUI only, 3.11.0) [C] | none (we never blocked it) |
| S2 TX power text field | `power=<0..7>` offered | removed for S2 (S2 power is `power_dBm` over SSP only) [C] | none (we never sent it) |
| Expected data rate for S1 | — | config value used for the S1 "no contact" timeout; S2 keeps timeslots × slot ms (fallback 3000 ms) [C] | none |
| Ephemeris transfer (§5.7) | 1 retry per chunk | download unchanged (≤ 40 calls, 1.5 s); upload: ≤ 50 B chunks with `0xFF` prefix unchanged, **up to 5 attempts per chunk**, 2 s each; whole upload retried not earlier than 60 s after a failure; "recent upload" window 300 s [C] | `aidChunkRetries` 5 |
| SA1 cable link (§1.1, §5.3 step 6) | second COM port 57600, S2 as central | the direct SA1 serial link is **no longer opened** by Windsond; `enable_sa1_connection` only logs [C]; the S2 is reached through the RR4's SSP network only [I] | SA1 baud left in the spec as legacy |
| RR4 crash backtrace | — | lines starting with `Backtrace: ` / `ELF file SHA256: ` are logged (3.8.5) [C] | classify as `log` lines (done) |
| SO2 sensor | — | symbol `so2` (856, ppb) — ontology only, not read by Windsond [C] | none |
| `raw_flight_history.csv` (§7.2) | fixed metric header `Temperature (C)` | header and values follow the display units: `Altitude ({m|ft} MSL)`, `Speed ({m/s|kt|…})`, **`Temperature (°C)`** (degree sign, also in metric), `Rise speed ({m|ft}/s)` (3.11.0) [C] | our writer keeps the 3.8.0 metric header (what s2stueve parses). s2stueve should accept `°C` and warn on `ft` |
| Custom file formats (§7.3) | — | new column label `GPS rise speed (m/s)`; template file text changed accordingly (3.11.5) [C] | none |
| WiFi | 3.8.1 "wifi settings dialog" | RR4 WiFi configuration over SSP (symbols 1500–1507) and a WebSocket SSP link in the Sparvio library — see §4 | `WebSocketLink`, `transport:'wifi'` |
| `sspt` → `ssp_ontology` refactor | ontology from txt files at run time | ontology compiled into a Python package; byte-level encoding rules unchanged (same type ids, same formats, same null values) [C] | none |
| `s2_link.py` removed | S2 handling in its own module | logic moved to `dongle.py` (`SspConnection`: RR4 + S2 views, default-set sync, encryption sync) and `ephemeris_sync.py` [C] | none |

---

## 2. Detailed findings per area

### 2.1 Transport and handshake [C]

* The RR4 enumerates as a native USB CDC device (Espressif VID `0x303a`, PID `0x1001`; the stand-alone
  WiFi tool also matches PID `0x80d3`). The library's device table lists the RR4 with 115200 Bd, but
  the application still opens it at 38400 Bd; for a native USB CDC port the rate is irrelevant [C/I].
* Handshake sequence (`echo=0`, `mac`, `about`) unchanged. `about` parsing is more tolerant (see table).
* A new reconnect detail: after a port (re)open, the net settings must arrive within the same 10 s
  window; otherwise the port is closed and reopened (as before) [C].
* Unknown lines beginning with `Backtrace: ` or `ELF file SHA256: ` are receiver crash dumps [C].

### 2.2 SSP core [C]

* Protocol version 3, magic 0xA6, link id 255, central id 1, component modulus 128 — unchanged.
* `compatibility` byte in CInfo is now 3. Bit 1 ("working get values") only tells the central that this
  client answers `get` requests correctly; it does not change anything the RR4 sends to a client that
  never acts as a server [I]. Sending 1 keeps working; we send 3 to match 3.11.8.
* Message table unchanged. The 3.11.8 library handles the ticketed forms `getR`, `ugetR`, `setR`,
  `callR`, `getVarTypeR`, `subR` when it is the *target* (irrelevant for us).
* New registry entries: 115 `Int32Fix1e6` = Fixpoint(signed, 32 bit, 6 decimals) (null = INT32_MIN);
  116 `Uint64AndNameMap` = Tuple(Uint64, NameMap); 117 `Uint32AndString` = Tuple(Uint32, String);
  118 `ListOfStrings` = TypedList(String).

### 2.3 Symbol table [C]

Added (id · name · meaning): 348 `startupCount`; 349/350 licence configuration (not described);
477 `sspDefaultSet` (RR4, type REF116, see 2.4); 553–562 `fileOpen/fileRead/fileWrite/fileStat/fileDelete/
fileSeek/fileClose/logDataWritten/logDataLost/logFile` (generic file access, not used by Windsond);
630 `jammingDetection`, 631 `spoofingDetection` (GNSS integrity, ontology only — the live flags travel as
bracket keys `jam`/`spoof`); 855 `triSamplingInterval`; 856 `so2` (ppb); 1112 `dropSpeedHMax`,
1113 `dropSpeedVMin` (drop-detection thresholds, ontology only); 1242 `radioNoise` (dBm);
1507 `wifiEnabled`; 10014 `launchSonde` (ontology only). Removed: none. Renamed/renumbered: none.
The WiFi symbols 1500–1506 already existed in 3.8.0's ontology; 3.11.8 adds `wifiEnabled` (1507) and
actually uses all of them (§4).

### 2.4 RR4 auto-sync of a connected S2 — `sspDefaultSet` (3.8.3) [C]

Variable 477 `sspDefaultSet` on the RR4 object, readable (`uget`) and settable (`set`), type REF116:

```
Tuple( opt : Uint64 ,  defaults : NameMap{ net: NetworkV6, txCriterion: U8, power_dBm: I16,
                                           powerBeforeLaunch_dBm: I16, encKey: EncryptionData } )
```

* Every entry is optional; Windsond includes `net` always (copy of the RR4's own `net`), the others
  only when the user configured a value ("leave unchanged" = omitted).
* `opt` is a bit mask over the map entries in insertion order: bit *n* set = the *n*-th entry is
  **optional** — Windsond sets it for `encKey` when the key payload is empty (= clear the key) and
  always for `powerBeforeLaunch_dBm` (not every S2 firmware has it) [I for the exact semantics, C for
  which bits are set].
* Procedure on RR4 connect: `getVarType` reveals whether `sspDefaultSet` exists. If yes: `uget` it
  (0.5 s / 1 s / 1.5 s retries), compare `net` with the RR4's current `net` report and the other
  entries with the desired values; on any difference `set` the rebuilt tuple. **The PC then does not
  touch the S2's settings at all** — the RR4 pushes them to every S2 that appears. If the RR4 has no
  `sspDefaultSet`, the 3.8.0 behaviour remains (per-variable `set` on the S2, now with 0.5/1/1.5 s
  retries and a read-back of `power_dBm`/`powerBeforeLaunch_dBm` to report clamping).
* Encryption keys use the same two paths (`encKey` on the S2 only when `encUnlocked` is true).

### 2.5 S2 object [C]

* Subscribed symbols: `gnssEnabled, md, mac, bat, net, condition, pr, txCriterion, power_dBm,
  powerBeforeLaunch_dBm, role`. `encUnlocked`/`encKey` live in a second view, read on demand.
* `role` (1109, Uint8) is settable: 1 reusable radiosonde, 2 one-time radiosonde, 3 dropsonde,
  4 tethersonde (new). Windsond writes it with `set` (3 attempts, 1 s each); a nack 5 = "S2 does not
  have role".
* No other S2 variable is newly written by Windsond; `relAlt`, `burn`, `burnTest`, `ledTest` are
  still not used over SSP (open question Q1 stands).

### 2.6 Text channel / sonde commands [C]

| Command | 3.8.0 | 3.11.8 |
|---|---|---|
| Cut-down now, sonde in init/ready/resting/find-me | `relBal=150` | same |
| Cut-down now, **S2** in flight (rising/falling/cutdown/rising-too-high) | `relBal` | **`mode=7`** |
| Cut-down now, other firmware ≥ 170 in flight | `relBal` | same (`relBal=<ms>` for older) |
| Second cut-down | `relGnd` | same; **success = RES text starts with `C`** (the sonde answers with its cut-down report), anything else → "received invalid response" |
| Beep | `beep=2900` | same |
| Behaviour after landing | `findme=0|1` | `findme=0|1|2` (2 = continue sounding) |
| Wake up resting sonde | `mode=5` | same |
| Parameter query | `params=04,06,13,15,17` (ids 4 behlan, 6 role, 13 fwver, 15 cutalt, 17 supmul) | same |
| S2 TX power | `power=<idx>` (S1 style) | not offered for S2 any more |

### 2.7 Bracket telemetry (§5.10) [C]

* Integer keys now: `pwr, gpse, behlan, logst, role, clk, resq, evt, fwver, mcnt, cutalt, cutpr2, supmul, gpa,
  galt, hw, burn, ucnt, tim, rssi, ctmr, net, twire, blk, beep, gpss, id, sid, r, rec, rec0, rec1, pa, lux,
  afc, afc0, afc1, jam, spoof`.
* Float keys now: `su, ang, spd, te, tei, hu, alt, rs, snr` (`rs`/`snr` moved from int to float).
  `q/q0/q1` stay hex bytes. Everything else is kept as text. (Our parser converts any numeric-looking
  value, so decimals in *any* key are accepted.)
* `jam`, `spoof`: 0 = nothing, 1 = suspected (the GUI keeps the first/last such message for 300 s and
  shows "Possible GNSS jamming/spoofing detected"), 2 = detected (status "Jamming / spoofing detected")
  [C for the levels 1/2 and the 300 s window, I for the wording "suspected/detected"].
* PC-side `sw_spoof`: a message is flagged when the GNSS altitude disagrees with the pressure altitude
  (reference pressure 1013.25 hPa, window 900 s, thresholds around 2000 m / 50 m per the constants) —
  this is a display heuristic, not protocol [I].
* `role` in DAT decides radiosonde/dropsonde dynamically (3.9.0); when 0/absent the capability letter
  `O` (one-time) or the configured default applies.
* No-contact timeout for S2: `radioTimeslots × radioSlotMs` (fallback 3000 ms); for S1 the configured
  update rate.

### 2.8 Frequency limits (§5.4) [C]

| Configuration | Allowed span (MHz) | Note |
|---|---|---|
| default | **400.000 – 440.000** | GUI label "Radio frequency (400-440MHz)" |
| extended ("defence" option) | **390.000 – 440.000** | GUI label "Radio frequency (390-440MHz)"; 3.10.1 fixed setting 390–400 |
| licence-defined | `[min, max]` from the licence file | 3.11.7; overrides the two above; **mechanism not described here** |

Validation: a frequency outside the active span is rejected before anything is sent (ValueError in
the GUI). The old hard check 400–450 MHz in the text setter is gone. The wire format is unchanged:
`frequency=<Hz>` (precise frequency, prot ≥ 5) / `freq=<10 kHz units>` (legacy).

### 2.9 Files (§7) [C]

* `raw_flight_history.csv`, `raw_history.csv`, `raw.csv`, `multi_sond_history.csv`: header text and the
  altitude / speed / temperature values are now written in the **configured display units**. With the
  default (metric) settings the only byte-level difference to 3.8.0 is the temperature unit
  `Temperature (°C)` / `Internal temperature (°C)` (UTF-8 degree sign) instead of `(C)`. With feet /
  knots / °F the header reads e.g. `Altitude (ft MSL)`, `Speed (kt)`, `Temperature (°F)`,
  `Rise speed (ft/s)` and the numbers are converted.
* Consequence for s2stueve (`parseCSV` matches `Altitude (m MSL)` and a column starting with
  `Temperature`): 3.11.x metric files still parse; imperial files are rejected with the structure error.
  S2 Ground keeps writing the 3.8.0 metric header (`Temperature (C)`), which both s2stueve and
  Windsond's own loaders accept.
* Template formats: new label `GPS rise speed (m/s)`; `altitude_agl_spacing` may now be used for the
  "overview" output.
* `.sounding` format unchanged (version 4); `# software=A3.11.8`.

### 2.10 Ephemeris (§5.7) [C]

Download from the RR4: unchanged. Upload to the S2: unchanged framing (UBX frames split at their
length field, `0xFF` prefix, ≤ 50-byte `gnssCmd` Blob calls), but each chunk is retried up to 5 times
(2 s timeout) before the upload is abandoned; a failed upload is retried at the earliest 60 s later;
a successful upload is not repeated within 300 s. Upload requires: S2 reachable over SSP, `md` < 8,
`gnssEnabled` true.

---

## 3. WiFi / WebSocket — findings for the owner's question

**Short answer:** the RR4 has a WiFi radio and the Sparvio library that ships with Windsond 3.11.8
contains a complete *WebSocket SSP link*, but **Windsond Desktop 3.11.8 never opens it**: every
connection to the RR4 in the analysed software still goes over USB. What the software does use is the
*configuration* of the RR4's WiFi over SSP (over USB). The WebSocket endpoint of the RR4 (host, port,
path) is therefore not in the material and has to be found on the hardware.

### 3.1 What is confirmed [C]

* **WiFi settings are ordinary SSP variables of the RR4 object** (symbols, all readable with `uget`/`get`,
  writable with `set`, except where noted):

  | id | name | type (as handled) | meaning |
  |---|---|---|---|
  | 1507 | `wifiEnabled` | Bool | WiFi radio on/off (absent on older RR4 firmware → "does not support WiFi") |
  | 1504 | `wifiAp` | Bool | true = RR4 creates its own network (access point), false = RR4 joins an existing network (client / station) |
  | 1502 | `wifiApSsid` | String | SSID broadcast in AP mode |
  | 1503 | `wifiApPwd` | String | AP password |
  | 1500 | `wifiClientSsid` | String | SSID to join in client mode |
  | 1501 | `wifiClientPwd` | String | its password |
  | 1505 | `ipAddr` | String **or** Uint32 (big-endian octets: value `a·2^24 + b·2^16 + c·2^8 + d` → `a.b.c.d`); empty / 0 = no address | the RR4's current IP address; **read by subscription** (`sub`, report) — it changes when the RR4 connects |
  | 1506 | `wifiApply` | function, `call` with null argument | commit the settings above (reconfigures the radio); Windsond waits up to 5 s for the reply, 3 attempts |

* **Procedure used by the "RR4 WiFi Settings" dialog:** `get` each of the six settings (1 s timeout per
  value; nack 5 "unknown variable" on any of them → RR4 has no WiFi); `sub ipAddr` and keep the
  subscription while the dialog is open; on *Apply*: `set` every changed variable (1 s, up to 3
  attempts each), then `call wifiApply` (5 s, up to 3 attempts), then re-read everything 0.5 s later.
  The GUI modes map as: "Disabled" → `wifiEnabled=false`; "Connect to existing WiFi" →
  `wifiEnabled=true, wifiAp=false`; "Create WiFi network" → `wifiEnabled=true, wifiAp=true`.
* **Status texts** (the GUI's interpretation): AP mode → "RR4 is serving as an access point with SSID …"
  (plus "visible to this PC" when the PC's WLAN scan lists the SSID); client mode with a non-empty
  `ipAddr` → "RR4 is connected to the network … and has the ip address …"; client mode without
  address → "RR4 is trying to connect …".
* **WebSocket SSP link (library class, not used by the application):**
  * Client connects to a URI given as a string (`ws://…`; the library uses a plain WebSocket client with
    a 1 s open timeout; `wss://` would work the same way).
  * **Framing: one binary WebSocket frame = `TO` byte + SSP message (message code byte + body),
    i.e. exactly the bytes of the serial hex line without `0x`/hex encoding and without the newline.**
    Received binary frames are parsed the same way (first byte = destination id, then the message).
    **Received text frames are discarded.**
  * Link-level probing: while not networked the client sends the CInfo probe (to = 255) every 2 s over
    the socket; the NewId / NewIdWithRev handshake, ids, tickets, keep-alive pings and everything else
    are identical to the serial link (sections 2 and 5.2 of the main document).
  * Reconnect: after an error the client waits 1.5 s (polling every 0.1 s, abortable) before
    reconnecting; receive is polled with a 1 s timeout; a closed connection marks the link offline
    and the network is forgotten (new CInfo probe after reconnect).
* **Discovery of the RR4's IP:** only through `ipAddr` read over USB (subscription) — there is no mDNS,
  no UDP broadcast, no fixed address in the material. The PC side scans visible SSIDs with the
  operating system's WLAN tool only to say whether the AP is visible.

### 3.2 What is *not* in the material [U]

1. The WebSocket **port and path** of the RR4 (`ws://<ip>:<port>/<path>`). Typical ESP32 choices are
   port 80 or 81 with path `/` or `/ws`; must be probed.
2. Whether the RR4 offers the **text/bracket channel over WiFi** at all. The library client ignores text
   frames, so if the RR4 sends `[#DAT:…]` lines as WebSocket *text* frames they are simply dropped by
   Windsond's library — they might still exist. Also possible: the RR4 serves the raw serial stream on a
   TCP port (telnet style) in addition to the WebSocket.
3. The RR4's **AP-mode IP address** (ESP-IDF default is 192.168.4.1), DHCP behaviour and whether the
   AP is open or WPA2.
4. Whether more than one SSP client may be connected at the same time (USB + WiFi).
5. Firmware version from which `wifiEnabled`/`wifiApply` exist.

### 3.3 Can an Android tablet talk to the RR4 over WiFi without USB? [I]

Yes for everything that goes over SSP — **if** the RR4 firmware really opens a WebSocket server (the
existence of the client class and of `wifiApply` strongly suggests it). Over SSP alone S2 Ground can:
join the network, discover RR4 and S2, read/write `net`, read S2 status (`md`, `bat`, `pr`, `mac`,
`condition`, `txCriterion`, power), set `role`, push settings, transfer ephemeris, and — once Q1 of
the main document is answered positively — fire `burn`/`burnTest`/`ledTest` and set `relAlt`.
**Not** available over SSP as far as the material shows: the live telemetry (`DAT`/`MET`/`PK`), the
`<id>.exe=` command/response channel (`relBal`, `relGnd`, `wires`, `mode=`, `params=`), the receiver's
text settings and `temp`/`bat`. Unless the hardware test shows a text channel over WiFi, a WiFi-only
tablet would have to get the telemetry another way (e.g. `sub` to the S2's `temp`/`rh`/`pr`/`alt`/`lat`/`lon`
over SSP — the S2 is a Sparvio object, so this is plausible [I] but was never exercised by Windsond).

What is needed in practice: (a) configure the RR4 once over USB (`wifiEnabled`, `wifiAp`, SSID/password,
`wifiApply`), (b) join the RR4's AP with the tablet (or put both on the same network and read `ipAddr`),
(c) connect `ws://<ip>:<port>/<path>` (to be determined), (d) run the SSP session over binary frames.
S2 Ground implements (a) as `GroundLink.readWifi()/writeWifi()` over USB and (c)/(d) as
`GroundLink.connect({transport:'wifi', wifi:{host, port, path}})`, reporting `transport:'wifi'` and
`textChannel:false` in the state so the UI can grey out text-channel features.

### 3.4 Spec chapter text (inserted as §1.8 of the main document)

> **§1.8 WiFi / WebSocket transport (3.11.8)** — The RR4 contains a WiFi radio configured through the
> SSP variables `wifiEnabled` (1507, Bool), `wifiAp` (1504, Bool: true = access point, false = client),
> `wifiApSsid`/`wifiApPwd` (1502/1503, String), `wifiClientSsid`/`wifiClientPwd` (1500/1501, String),
> read with `get`/`uget`, written with `set` and committed with `call wifiApply` (1506, null argument,
> reply within 5 s). The current address is `ipAddr` (1505; String, or Uint32 with the first octet in
> the most significant byte; empty/0 = none), delivered by subscription. All of this runs over the USB
> link [C]. The Sparvio library defines an SSP link over a WebSocket: the client opens `ws://<host>[:port][/path]`
> (open timeout 1 s), sends and receives **binary frames that contain exactly `TO` + MSGTYPE + body** —
> the serial frame without hex encoding and line terminator —, ignores text frames, probes with CInfo
> every 2 s until networked and otherwise behaves like the serial SSP link (same ids, tickets,
> keep-alive, reconnect after 1.5 s) [C]. The RR4's port/path, its AP address and whether the bracket
> channel is also available over WiFi are not in the material [U]; Windsond 3.11.8 itself only uses USB.

---

## 4. Open questions (updated; numbering continues the main document's §8)

19. **WebSocket endpoint**: on an RR4 with `wifiEnabled=true, wifiAp=true` join the AP, read `ipAddr`
    over USB, then probe `ws://<ip>/`, `ws://<ip>/ws`, `ws://<ip>:81/`, `ws://<ip>:8080/` (and a TCP port
    scan 1–10000). Record which one accepts the CInfo probe (binary frame `ff 04 03 a6 00 …`) with a
    NewId.
20. **Text channel over WiFi**: while connected, send `about` as a WebSocket text frame and as a
    binary frame; watch for text frames. Also check whether the RR4 streams `[#DAT…]` lines on a raw
    TCP port.
21. **`sspDefaultSet` acceptance**: `getVarType sspDefaultSet` on the RR4 (expect REF116). Set a tuple
    with only `net` and `opt=0`; confirm with `uget` that the RR4 stores it and that a freshly powered
    S2 receives the RR4's `net` without the PC pushing it. Then test an optional entry (bit set) that
    the S2 does not support.
22. **`mode=7` as cut-down**: confirm on the ground (no balloon) that `<id>.exe=mode=7` on an S2 in mode
    2/3 fires the wire, and what RES text comes back; compare with `relBal`.
23. **`relGnd` RES text**: capture the exact RES of a successful secondary cut-down (expected to start
    with `C(`) and of an unconfigured secondary wire.
24. **`role=4` (tethersonde)**: does the S2 firmware accept it; what changes in behaviour.
25. **`jam`/`spoof` keys**: capture DAT lines from an S2 with the newer firmware; confirm the value range
    (0/1/2) and in which message types the keys appear.
26. **`findme=2`**: confirm the S2 accepts behaviour 2 and what the `behlan` parameter reads back.
27. **Frequency 390–400 MHz**: does the RR4 accept `frequency=395000000` (prot 6) without a licence
    restriction in the firmware?
28. **CSV**: confirm the 3.11.8 `raw_flight_history.csv` header on a metric installation reads
    `Temperature (°C)` (UTF-8) and that s2stueve parses it.
