# Interface specification: Sparv RR4 receiver / S2 radiosonde as used by Windsond 3.8.0 / 3.11.8

Revision 2 (2026-10-28): updated against Windsond Desktop **3.11.8**; the delta with the reasoning is in `CHANGES-3.11.8.md`. Statements that changed between 3.8.0 and 3.11.8 are marked *(3.11.8)*.

Working document, derived for interoperability (Swiss URG Art. 21 / EU 2009/24/EC).
Everything below is a description in our own words of *what goes over the wire* and *what files are written*; no program code of the original software is reproduced. Vendor secrets (license key material, the GNSS assistance service token) are deliberately **not** included.

Confidence marks used throughout:

| Mark | Meaning |
|---|---|
| **[C]** | confirmed: directly visible in constants / control flow of the analysed software |
| **[I]** | inferred: strongly suggested by names, comments or surrounding logic, not executed against hardware |
| **[U]** | unknown / to be verified with hardware (collected in section 8) |

---

## 0. Big picture (read this first)

The PC talks to the RR4 over one USB virtual COM port. **Two protocols share that one port, line by line** [C]:

1. **Text command protocol ("bracket protocol")** — human-readable, one command per line (`about`, `mac`, `frequency=433000000`, `12345.exe=relBal`, ...). The receiver answers with one line in square brackets `[...]`. **All radio traffic from sondes is delivered to the PC as bracket lines of the form `[#TYPE:key=value,...:data]`.** This is the channel that carries the live telemetry, the sonde command/response channel (cut-down, LED/burn tests, mode changes, parameter queries) and the receiver's own settings when read/written the "classic" way.
2. **SSP object protocol ("SSP-BIN over hex lines")** — binary object protocol of Sparv's "Sparvio" framework, each frame hex-encoded on its own line starting with `0x`. Over SSP the PC joins a small network whose *central* is the RR4 (component id 1). The RR4 exposes itself as an object (name `RR4` or `RR4_...`) and, when an S2 is reachable (via the RR4 radio link or via the SA1 USB cable adapter on a second COM port), the S2 as another object (name `S2` or `S2_...`). SSP is used by Windsond 3.8.0 for: network ("net") settings, GNSS aiding/ephemeris transfer, encryption key, GNSS constellation configuration, satellite signal display, S2 status (mode, battery, pressure, condition, MAC, TX power, TX criterion), S2 pressure calibration, and the S2 radio settings sync.

Both protocols are interleaved on the same serial line; the receiver side classifies each received line by its first character(s): `0x` → SSP frame, `[` → bracket message/response, other → log/ignored [C].

What the software does **not** do over SSP in 3.8.0 (so it cannot be "confirmed" from it): setting `relAlt`, calling `burn`/`burnTest`/`ledTest`, reading `serNo`/`fwVerStr`/`uptime`, changing `md`. Those symbols exist in the shipped ontology for radiosondes [C] and the S2 is a Sparvio device, so they are very probably callable over SSP [I] — but the *equivalent operations that Windsond actually performs* go through the text channel (`<id>.exe=relBal`, `<id>.exe=wires`, `<id>.exe=mode=5`, `params=...`) [C]. A new application should implement the text channel first (it is what is proven to work) and may additionally try the SSP symbols.

---

## 1. Transport

### 1.1 Serial parameters

| Item | RR4 (receiver) | S2 via SA1 cable | Source/confidence |
|---|---|---|---|
| Baud rate | **38400** | **57600** (legacy) | [C] (daemon created with baud=38400 for the receiver, 57600 for the SA1 link; 115200 is only the library default and is *not* used). *(3.11.8)* The RR4 is a native USB CDC device (USB VID `0x303a`, PID `0x1001`; the WiFi tool also accepts PID `0x80d3`), so the rate is nominal; 3.11.8 no longer opens the SA1 cable link at all (the S2 is reached only through the RR4's SSP network) [C]. |
| Framing | 8N1 (library default) | 8N1 | [I] |
| Read timeout / inter-byte timeout / write timeout | 0.25 s / 0.01 s / 1 s | same | [C] |
| Exclusive open | yes (newer pyserial) | yes | [C] |
| RTS | driven low on Windows after open | same | [C] |
| Line ending sent by PC | `\r\n` (text commands); SSP hex lines are sent as `\n0x…\n` | same | [C] |
| Line ending accepted from device | `\r\n`, `\n`, `\r` (any; no empty line generated between `\r\n` / `\n\r`) | same | [C] |
| Character set | ASCII (latin-1 decoding on receive, non-ASCII ignored on send) | same | [C] |
| Minimum spacing between consecutive text commands | 0.2 s | — | [C] |

Legacy receivers (RR1/RR2) used other baud rates; irrelevant here.

### 1.2 Line classification on receive [C]

For each complete line (after stripping leading `>` prompt characters and whitespace):

| Line starts with | Meaning |
|---|---|
| `0x` (also tolerated: `x…` → `0x…`, `00x…` → `0x…`, leading NUL bytes stripped) | SSP-BIN frame, hex encoded, lower-case or upper-case hex digits; decoding stops at the first non-hex character pair (the rest must be empty) |
| `[#` … `]` | **radio/sonde message** (asynchronous, unsolicited) |
| `[` … `]` (no `#`) | **response to the last text command** |
| matches `[…][X][…]…` | device log line (ignored) |
| anything else | "unknown data", ignored |

A bracket message may be preceded by junk; the receiver searches for the first `[` and the matching `]` and ignores the rest of the line.

### 1.3 Text command protocol (RR4 side) [C]

* Command: `<text>\r\n`. Response: exactly one line `[<text>]`. Windsond waits by default **0.4 s** (2.0 s for the first `echo=0`) for the response; some settings retry up to 4 times on timeout.
* Error responses start with `Error` or `Failed` (e.g. `[Error: ...]`) and are still "accepted" responses [C].
* Multi-line / long replies are not used; the `about` reply contains embedded `\n` inside the quotes and is treated as one line (see 5.1).

### 1.4 Hex SSP frame layout [C]

```
"0x" + hex( TO(1 byte) + MSGTYPE(1 byte) + MESSAGE BODY ) + "\n"
```

* `TO` = destination component id (object id). `0xFF` = "link-local" (the direct neighbour on this serial link, used before an id is assigned). `0x00` = invalid.
* `MSGTYPE` = one byte, see section 2. Bit 7 (0x80) set on a request means "a reply with `from`/`tk` is expected" (ticketed request).
* The body is the implicit-binary encoding (section 3) of the message struct for that `MSGTYPE`.
* **No length field, no checksum, no CRC** inside the frame; integrity is given by the line framing + hex alphabet only [C]. Sizes of variable-length items are embedded in the encoding.
* Max observed sizes: all counts are single bytes (max 255 elements / 255 bytes per string or blob).

### 1.5 Addressing and multiplexing of the S2 [C]

* Component ids are 1 byte; `1` is reserved for the **central** (the RR4 when connected through the RR4; the S2 itself when connected through the SA1 cable). `255` = link id, `0` = invalid. Values ≥ 128 are "internal objects" (object id = internalId·128 + componentId); not used here.
* The PC gets its own id from the central (section 5.2). Messages are routed by the central: the PC simply addresses the S2's component id in `TO`; the RR4 forwards the frame over radio (or over its own link) and returns the S2's replies/reports with `from` = S2 id. Nothing special is needed on the PC side for the multiplexing; the RR4 is a transparent router for SSP.
* The S2 is discovered as an element of the central's `components` list whose `name` begins with `S2` (section 5.3).

### 1.6 Timeouts, keep-alive, reconnection [C]

| Item | Value |
|---|---|
| Link probe (CInfo) when not networked | every ~3 s (plus random 0–0.25 s jitter) |
| Keep-alive when networked | if no SSP message was received for ~3 s, send `ping` (call of symbol 24 on the neighbour with our own id as argument) and wait up to 1 s for the reply; failure → link considered lost → forget network, start probing again |
| Reply wait for individual requests | 1.5 s (`name`), 2 s (getVarType / subscribe / set `net` / gnssCmd chunk), 1.5 s (gnssGetAid chunk) |
| Network must be established within | 10 s after the port opened, else Windsond closes and reopens the COM port |
| Poll of RR4 own sensors (`temp`, `bat` text commands) | every 1.5 s while displayed (5 s after an error reply) |
| Sonde-command dispatch loop | every 2 s (first after 3 s) at most one queued sonde command is sent to the RR4; the RR4 acknowledges the `<id>.exe=` line within 0.4 s, the sonde answer (RES) may take up to 8 s |

### 1.7 Encryption

The RR4/S2 radio link can be AES-encrypted (`encKey` struct, 16-byte key + timestamp). Out of scope; only mentioned where it appears in the discovery sequence. With no key set the devices run unencrypted (`payload` empty) [C].

### 1.8 WiFi / WebSocket transport (3.11.8)

The RR4 contains a WiFi radio that is **configured through SSP variables of the RR4 object** (all over the USB link) [C]:

| id | name | type (as handled by Windsond) | access | meaning |
|---|---|---|---|---|
| 1507 | `wifiEnabled` | Bool | get, set | WiFi radio on/off; absent (nack 5) on firmware without WiFi |
| 1504 | `wifiAp` | Bool | get, set | true = access point (RR4 creates a network), false = client (RR4 joins a network) |
| 1502 / 1503 | `wifiApSsid` / `wifiApPwd` | String | get, set | AP SSID / password |
| 1500 / 1501 | `wifiClientSsid` / `wifiClientPwd` | String | get, set | SSID / password of the network to join |
| 1505 | `ipAddr` | String, or Uint32 with the first octet in the most significant byte (`a·2^24+b·2^16+c·2^8+d` → `a.b.c.d`); empty / 0 = no address | sub (report) | current IP address of the RR4 |
| 1506 | `wifiApply` | function, `call` with null argument | call | commit the settings (reconfigures the radio); reply within 5 s |

Procedure (the "RR4 WiFi Settings" dialog): `get` the six settings (1 s each; a nack "unknown variable" = no WiFi support), `sub ipAddr`; on apply `set` every changed value (1 s, 3 attempts), then `call wifiApply` (5 s, 3 attempts), re-read after 0.5 s. GUI modes: disabled = `wifiEnabled=false`; "connect to existing WiFi" = `wifiEnabled=true, wifiAp=false`; "create WiFi network" = `wifiEnabled=true, wifiAp=true` [C]. The only way the PC learns the RR4's address is `ipAddr` over USB; no discovery protocol exists in the material [C].

**SSP over WebSocket** (Sparvio library class; *not used by Windsond 3.11.8 itself*, which always talks USB) [C]:

* The client opens `ws://<host>[:port][/path]` with a 1 s open timeout (`wss://` would work identically).
* **One binary WebSocket frame = `TO` (1 byte) + MSGTYPE (1 byte) + body** — exactly the bytes of the serial hex line without the `0x`/hex encoding and without the newline (section 1.4). Received binary frames are decoded the same way; **text frames are ignored**.
* While not networked the client sends the CInfo probe (`TO = 255`, section 2.2) every 2 s as a binary frame; NewId/NewIdWithRev handshake, ids, tickets, keep-alive and reports are identical to the serial link (sections 2, 5.2).
* Receive is polled with a 1 s timeout; after an error the client waits 1.5 s before reconnecting; a closed socket marks the link offline and forgets the network (new probe after reconnect).

Not in the material [U]: the RR4's WebSocket port and path, its AP-mode address (ESP-IDF default would be 192.168.4.1), whether the bracket/text channel (telemetry, `<id>.exe=`) is available over WiFi at all (the library client would drop it as text frames), and whether USB and WiFi clients may be connected simultaneously. See `CHANGES-3.11.8.md` §3 and open questions 19–20.

---

## 2. SSP message types

### 2.1 Message codes [C]

| Code (dec/hex) | Name | Direction | Struct fields after the code byte (in order) |
|---|---|---|---|
| 4 / 0x04 | `cinfo` | both | `ver:U8, magicByte:U8, tk:U8, serial:U32, id:U8, parent:U8, prio:U8, component_type:U8, compatibility:U8, name:String` |
| 5 / 0x05 | `newid` | central → component | `tk:U8, id:U8, prio:U8, name:String` |
| 31 / 0x1F | `newidWithRev` | central → component | `tk:U8, id:U8, prio:U8, revision:U8, name:String` |
| 32 / 0x20 | `newidAck` | component → central | `revision:U8` |
| 6 / 0x06 | `reply` | responder → requester | `from:U8, tk:U8, b:Any` |
| 7 / 0x07 | `ack` | responder → requester | `from:U8, tk:U8, b:Any` |
| 8 / 0x08 | `nack` | responder → requester | `from:U8, tk:U8, code:U8` (error code, section 2.3) |
| 11 / 0x0B | `rep` (report) | object → subscriber | `map:OidMap` = TypedMap(Oid, Any) → each value is a NameMap (TypedMap(Symbol, Any)) of variable values |
| 14 / 0x0E | `call` (no reply wanted) | caller → object | `sym:Symbol, arg:Any` |
| 142 / 0x8E | `call` with reply | caller → object | `from:U8, tk:U8, sym:Symbol, arg:Any` |
| 15 / 0x0F | `uget` | — | `var:SymbolList` (values are returned by report, no ticket) |
| 143 / 0x8F | `uget` with reply (**this is what Windsond uses for "get"**) | requester → object | `from:U8, tk:U8, var:SymbolList` |
| 16 / 0x10 | `get` | — | `var:SymbolList` |
| 144 / 0x90 | `get` with reply | — | `from:U8, tk:U8, var:SymbolList` |
| 17 / 0x11 | `set` (no reply) | — | `map:NameMap` |
| 145 / 0x91 | `set` with reply (**used**) | requester → object | `from:U8, tk:U8, map:NameMap` |
| 18 / 0x12 | `sub` (**used**) | subscriber → object | `from:U8, sym:SymbolList` (object answers with reports) |
| 146 / 0x92 | `sub` with ack | subscriber → object | `from:U8, tk:U8, sender:U8, sym:SymbolList` |
| 19 / 0x13 | `unsub` (**used**) | subscriber → object | `from:U8, sym:SymbolList` |
| 147 / 0x93 | `unsub` with ack | — | `from:U8, tk:U8, sender:U8, sym:SymbolList` |
| 149 / 0x95 | `getVarType` (**used**) | requester → object | `from:U8, tk:U8, sym:SymbolList` |
| 154 / 0x9A | `getVarList` reply form | — | `from:U8, tk:U8` |
| 30 / 0x1E | `wentoffline` | → central | `from:U8, ids:Uint8List` |

Notes:
* The "a:" tag inside each struct (the message name) occupies **zero bytes** on the wire; it is only the Python-side discriminator [C].
* Replies carry the requester's ticket `tk` back; the requester matches on `tk` only (not on `from`) [C].
* **Tickets**: 1 byte, Windsond allocates 1..250 round-robin, skipping tickets still in use; 0 is used in CInfo [C].
* `uget` means "get without unit conversion"; semantic difference vs `get` is not visible on the wire [I].
* `b` in `reply` to a (u)get is a **List** (regIx 25) of the values in the order of the requested symbols [C]. `b` in a reply to `getVarType` is a list of 2-tuples (schema, settable flag 0/1) in symbol order (registry entries 96/99); a schema is a regIx byte for registered types or a format descriptor (3.2) [C for the Python side, I for the exact bytes from the device]. `b` in a reply to `set` is `null` (or ignored) [C]. `b` in a reply to `call` is the function result (`Any`). `ack` is accepted for `call` (partial result; the final result arrives later in a `reply`) [C].

### 2.2 CInfo constants [C]

| Field | Value sent by PC | Notes |
|---|---|---|
| `ver` | 3 | SSP protocol version; a `cinfo` with another version is rejected |
| `magicByte` | 0xA6 (166) | fixed |
| `tk` | 0 | — |
| `serial` | 1 | Windsond uses 1; any value is acceptable (random 2..0xFFFFFFFE otherwise) |
| `id` | 0 (not yet networked) | — |
| `parent` | 0 | — |
| `prio` | 0 | the PC never wants to be central |
| `component_type` | 0 | unknown type |
| `compatibility` | 1 (3.8.0) / **3** (3.11.8) | bit 0 "I understand newidWithRev", bit 1 "working get values" (3.11.8; only relevant when the client acts as a server) [C] |
| `name` | `"python"` | preferred name of the PC object; the central may rename it (empty string in NewId = keep requested name) |

### 2.3 Error codes (`nack.code`) [C]

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Unspecified failure |
| 2 | Out of memory |
| 3 | Busy |
| 4 | Not delivered |
| 5 | Unknown variable |
| 6 | Argument error |
| 7 | Data error (corrupt) |
| 8 | Blocked (unmet prerequisites) |
| 9 | Unknown definition |
| 10 | External error |
| 11 | Logical error |
| 12 | Unknown object |
| 13 | Too big data |
| 14 | Feature not supported |
| 15 | Text parsing error |
| 16 | Timeout |
| 17 | End of data |
| 18 | Out of resources |
| 127 | Yield |
| 128 | OK pending |

### 2.4 Byte-level example frames (synthetic, generated from this spec)

All examples assume: RR4 = central, id 1; PC was assigned id 3; S2 has id 2. Spaces are inserted for readability only.

```
PC → link   CInfo probe
0x ff 04 | 03 a6 00 01000000 00 00 00 00 01 06 707974686f6e
   to=255 cinfo ver=3 magic=A6 tk=0 serial=1 id=0 parent=0 prio=0 ctype=0 compat=1 name="python"

central → PC   NewId  (tk = central's id = 1; our id = 3; prio 50; name "" = keep)
0x ff 05 | 01 03 32 00

central → PC   NewIdWithRev / PC → central NewIdAck (revision 7)
0x ff 1f | 01 03 32 07 00
0x ff 20 | 07

PC → RR4(1)   subscribe to 'components' (sym 13), from=3
0x 01 12 | 03 01 0d

RR4 → PC(3)   report: map{ 1: NameMap{ components: List[U8 1, U8 2] } }
0x 03 0b | 01  01  1f 01 0d  19 02 02 01 02 02
            |   |   |  |  |   |  |  ^^^^^ ^^^^^ two expBin uint8 elements
            |   |   |  |  |   |  count=2
            |   |   |  |  |   regIx 25 = List
            |   |   |  |  symbol 13 'components'
            |   |   |  NameMap count=1
            |   |   regIx 31 = NameMap (value is "Any" → explicit type byte)
            |   oid 1
            map count=1

PC → S2(2)   uget 'name' (sym 5), ticket 1
0x 02 8f | 03 01 01 05

S2 → PC      reply from=2 tk=1 b=List["S2"]
0x 03 06 | 02 01 19 01 09 02 5332

PC → S2      getVarType md(1100), bat(314), ticket 2
0x 02 95 | 03 02 02 cc08 ba02        (symbols are varuint: 1100 = cc 08, 314 = ba 02)

PC → S2      subscribe md, bat, pr(890), mac(1200)
0x 02 12 | 03 04 cc08 ba02 fa06 b009

S2 → PC      report md=1 (U8), bat=4.05 (Float), pr=98650 (U32)
0x 03 0b | 01 02 1f 03 cc08 02 01  ba02 07 9a998140  fa06 06 5a810100

PC → S2      set relAlt(1105)=3000 (U16), ticket 4
0x 02 91 | 03 04 01 d108 03 b80b

S2 → PC      reply (ok)            /  nack code 5 (unknown variable)
0x 03 06 | 02 04 00                 /  0x 03 08 | 02 04 05

PC → S2      call ledTest(1107) with null argument, ticket 5
0x 02 8e | 03 05 d308 00

PC → S2      call gnssCmd(594) with a Blob argument (0xFF + UBX bytes)
0x 02 8e | 03 06 d204 0a 0b ffb562130002000102195b

PC → RR4     call gnssGetAid(598) with null argument
0x 01 8e | 03 07 d604 00

PC → RR4     ping (sym 24) with our id as argument
0x 01 8e | 03 08 18 02 03

PC → RR4     set net (struct REF105): freq 433.000000 MHz, SF9, BW0, CR1, 6 slots, 500 ms, 60 B, 1000 ms, 500 ms
0x 01 91 | 03 09 01 b109 69 400ecf19 09 00 01 06 f401 3c e803 f401

PC → S2      unsubscribe md
0x 02 13 | 03 01 cc08
```

---

## 3. Data types and encoding (SSP-BIN)

### 3.1 General rules [C]

* All multi-byte integers and floats are **little-endian**. Float = IEEE-754 single precision. No 64-bit floats.
* Every value appears either **implicitly typed** ("impBin": the type is known from context, e.g. a struct field) or **explicitly typed** ("expBin": one *type/registry index byte* ("regIx") followed by the impBin value). `Any` fields and the values inside `NameMap` / `OidMap` / `List` / `Map` are expBin.
* A registry index (regIx) is a single byte: built-in types 0–28, formats 12–23, shared schemas (REF entries of the ontology) 32–127.
* **Symbols** (variable / function names) are encoded as a **varuint** (base-128, 7 bits per byte, least significant group first, bit 7 = continuation): e.g. 5 → `05`, 314 → `ba 02`, 1100 → `cc 08`. Symbol index 1 (`ASCII`) followed by a String means "symbol given by name" [C]. Symbol 0 is invalid.
* Sizes/counts are **one byte** (strings, blobs, lists, maps, struct element counts).

### 3.2 Built-in type indices [C]

| regIx | Name | impBin encoding | Null representation |
|---|---|---|---|
| 0 | Null | nothing (type byte alone in expBin) | — |
| 1 | Bool | U8, 0/1 | 255 |
| 2 | Uint8 | 1 byte | 255 |
| 3 | Uint16 | 2 bytes LE | 65535 |
| 4 | Int16 | 2 bytes LE two's complement | -32768 |
| 5 | Int32 | 4 bytes LE | -2^31 |
| 6 | Uint32 | 4 bytes LE | 0xFFFFFFFF |
| 7 | Float | 4 bytes IEEE754 LE | +Inf |
| 8 | Symbol | varuint | symbol 3 (`NULL`) when a symbol is expected but none available |
| 9 | String | U8 length + ASCII bytes (no terminator) | — |
| 10 | Blob | U8 length + bytes | — |
| 11 | Schema | a schema description (regIx, or format + parameters) | — |
| 12 | *format* Constant | schema followed by the value | — |
| 13 | *format* TypedMap(K,V) | schema: 13, regIx K, regIx V; value: U8 count, then count × (K impBin, V impBin) | — |
| 14 | *format* Struct | schema: 14, U8 n, n × (Symbol name, regIx type); value: fields concatenated in order, no count | — |
| 15 | *format* Tuple | schema: 15, U8 n, n × regIx; value: elements concatenated | — |
| 16 | *format* TypedList(T) | schema: 16, regIx T; value: U8 count + elements | — |
| 17 | *format* TypedList(n, T) fixed size | schema: 17, U8 n, regIx T; value: elements only (no count) | — |
| 18 | *format* Concatenated data | not used here | — |
| 19 | *format* Fixpoint(signed, bits, decimals) | schema: 19, U8 signed(0/1), U8 bits (8/16/32/64), U8 decimals; value: integer of that width; real value = int / 10^decimals | type null |
| 20 | *format* Extend | not used | — |
| 21 | Any | expBin value | — |
| 22 | Map | = TypedMap(Any, Any): U8 count + count × (expBin key, expBin value) | — |
| 23 | *format* Scaled(bits, signed, scale f32, offset f32) | value: integer; real = int·scale + offset (order of params: bits, signed, scale, offset) | — |
| 25 | List | = TypedList(Any): U8 count + count × expBin | — |
| 26 | Ref | regIx byte (reference to a registry entry) | — |
| 27 | Int64 | 8 bytes LE | -2^63 |
| 28 | Uint64 | 8 bytes LE | 0xFFFFFFFFFFFFFFFF |
| 250 | *format* Union(options, keyType) | value: key (keyType impBin) followed by the chosen option's impBin | — |

A **Python/JS-side encoder** choosing types for "Any" values should mimic Windsond [C]: bool → Bool; int → the first of Uint8, Uint16, Int16, Uint32, Int32 that fits; float → Float; str → Symbol if the name is in the ontology, else String; bytes → Blob; list → List; dict → Map (keys as symbols/Any).

### 3.3 Shared schemas (registry, REF entries) relevant here [C]

| regIx | Label / C name | Definition |
|---|---|---|
| 31 | NameMap | TypedMap(Symbol, Any) — used for `set.map` and inside reports |
| 32–40 | Uint16Fix10 … Int32Fix1e6 | Fixpoint(0,16,1), (0,16,2), (0,16,3), (1,16,1), (1,16,2), (1,16,3), (0,32,3), (1,32,1), (1,32,6) (REF40 = GPS degrees·1e6) |
| 42 | Uint8List | TypedList(Uint8) |
| 43 | SymbolList | TypedList(Symbol) |
| 46 | Date | Struct{year:U8 (2000+), month:U8, day:U8} |
| 48 | Network (protocol 1, legacy) | Struct{netId:U8, freqMhz:Uint16Fix100, format:U8, baud:U8, duty:U8} |
| 52 | Version2 | Struct{verMajor:U8, verMinor:U8} |
| 61, 63, 64 | Int32Fix1000, Int32Fix10000, Uint32Fix10000 | Fixpoint |
| 66 | FuncSig | Tuple(Ref, Ref) (argument type, return type) |
| 67 | FuncSigList | TypedMap(Symbol, FuncSig) |
| 73 | — | Tuple(Uint8, String) "used for S2 execute (sender, command)" |
| 74 | UtcSync | Struct{lTime:U64, utc:U64} |
| 75 | Oid | Uint8 |
| 86 | OidMap | TypedMap(Oid, Any) — `rep.map` |
| 94 | — | TypedMap(Uint8, Uint8) (gnssSignals, older form) |
| 96 / 99 | SchemaList / SchemaUint8Tuple | TypedList(Tuple(Schema, Uint8)) — reply to getVarType (schema, settable-flag) |
| 101 | Uint64Fix1000 | Fixpoint(0,64,3) |
| 102 | Network V5 | Struct{netId:U8, freq:U32 Hz, loraSpreadingFactor:U8, loraBandwidth:U8, loraCodingRate:U8, radioTimeslots:U8, radioSlotMs:U16, radioMaxData:U8, samplingInterval:U16 ms, radioGroundSlotMs:U16} |
| 105 | Network V6 | same as 102 **without** `netId` |
| 104 | EncryptionData | Struct{payload:Blob (16 bytes or empty), unixEpochStamp:Uint64Fix1000} |
| 106 | TimeSeriesUint8 | Struct{samplingInterval:Float, payload:Uint8List} |
| 107–109 | Uint32List, Uint16AndUint32List, OidList | — |
| 112 | — | Tuple(Uint8, Uint16, String) "execute or command (isOneway, sender, command)" |
| 113 / 114 | GnssSat / list | Struct{gnssId:U8, satId:U8, cno:U8, flags:U8} / TypedList(GnssSat) |
| 115 | Int32Fix1e6 *(3.11.8)* | Fixpoint(1,32,6) |
| 116 | Uint64AndNameMap *(3.11.8)* | Tuple(Uint64, NameMap) — value of `sspDefaultSet` (§5.5) |
| 117 | Uint32AndString *(3.11.8)* | Tuple(Uint32, String) |
| 118 | ListOfStrings *(3.11.8)* | TypedList(String) |

**Which `net` struct a device uses is negotiated at run time**: Windsond asks the RR4 with `getVarType` for `net` and then encodes the `set` with exactly the schema returned (REF105 observed as "LoRa settings in net" for protocol 5/6) [C]. Do the same.

### 3.4 Units and timestamps

* Units are documented per symbol in the ontology (section 4 tables) and are *not* transmitted. Pressure in pascal, temperature in °C, voltages in volt, frequencies in Hz (`freq`) or MHz·100 (`freqMhz`, legacy), altitudes in metres.
* Time: `utc` (sym 17) = seconds after UTC midnight; `unixEpochStamp` (776) = seconds since 1970; `lTime` (25) = device ticks; `utcSyncSource` (774) = quality of time sync (≤2 bad, 3 uncertain, ≥4 good) [C].
* SSP reports carry **no timestamp**; the PC timestamps on receipt [C].

---

## 4. Object model

The RR4 and the S2 are Sparvio objects. Each object has variables (readable via `uget`/`sub`, some settable via `set`), functions (`call`), and events (`sub`). Symbol ids are global (one dictionary for all devices). The full machine-readable table is in `symbols.json`; the tables below list what matters for this project.

### 4.1 Discovery / common symbols (every Sparvio object) [C]

| id | name | type | r/w | meaning |
|---|---|---|---|---|
| 4 | id | Uint8 | r | object/component id |
| 5 | name | String | r (w via setComponentName) | object name; RR4 reports `RR4`/`RR4_…`, S2 reports `S2`/`S2_…` |
| 6 | serNo | — | r | device serial number [I: not read by Windsond; the sonde number is read as `mac`] |
| 7 | class | Ref | r | class registry entry |
| 9 / 10 / 11 / 12 | vars / funcs / events / funcSigs | SymbolList / FuncSigList | r | introspection |
| 13 | components | List of Oid | r/sub | **central only**: ids of all components in the network (used to find RR4 and S2) |
| 14 / 15 | parent / neig | — | r | topology |
| 24 | ping | fn(Oid)→Oid | call | keep-alive |
| 17 / 25 / 776 / 774 | utc / lTime / unixEpochStamp / utcSyncSource | — | r | time |
| 300 / 345 | fwVer / fwVerStr | — / String | r | firmware version [I] |
| 309 / 310 | chipId / uptime | — / sec | r | [I] |
| 314 | bat | Float volt | r/sub | supply voltage (S2: subscribed) |
| 336 | condition | Uint32 bitmask | r/sub | errors (bits 0–10) and warnings (bits 16–23), see 6.3 |
| 301 / 302 / 303 / 305 / 331 | reset / shutdown / factoryReset / identify / beep | fn | call | [I] |
| 1200 | mac | Uint32 | r/sub | radio address = **sonde number** (S2) / receiver MAC (RR4 also answers the text command `mac`) |
| 1201 | net | Struct REF105/102 | r/w/sub | radio network settings (frequency, LoRa parameters, TDMA slots, sampling interval) |
| 1235 / 1241 / 1240 | encKey / encUnlocked / encUnlock | REF104 / Bool / fn | r/w | encryption (out of scope) |
| 570–577 | lat, lon, pos, alt, sats, hdop, dir, spd | — | r | GNSS data of the object itself |
| 586 / 587 / 599 / 598 / 594 / 600 / 596 / 628 / 609 | gnssGoodFix / gnssEnabled / gnssHasAid / gnssGetAid / gnssCmd / doColdGnssStart / gnssSignals / gnssEnabledConstellations / gnssFixType | Bool / Bool / Bool / fn→Blob / fn(Blob) / fn / map or list / U8 bitmask / U8 | see 4.2/4.3 | GNSS |
| 890 / 891 / 892 / 893 | pr / prCalOf / prCalRef / baroTemp | pascal | r / rw / w / r | barometer |
| 700 / 701 | temp / rh | °C / % | r | ambient sensors (telemetry comes via the text channel, not subscribed over SSP in 3.8.0) |
| 5203 | rbeep | Bool | w | receiver beeps on every received packet (RR4 also accepts the text command `rbeep=0/1`) |
| 477 | sspDefaultSet *(3.11.8)* | REF116 Tuple(U64 opt, NameMap) | r/w | **RR4 only**: default settings the RR4 pushes to every S2 it sees (§5.5) |
| 1500–1507 | wifiClientSsid, wifiClientPwd, wifiApSsid, wifiApPwd, wifiAp, ipAddr, wifiApply, wifiEnabled *(3.11.8)* | see §1.8 | rw / sub / call | WiFi configuration of the RR4 |
| 630 / 631 | jammingDetection / spoofingDetection *(3.11.8)* | — | — | GNSS integrity (ontology only; the live flags arrive as bracket keys `jam`/`spoof`, §5.10) [I] |
| 1242 | radioNoise *(3.11.8)* | dBm | r | radio noise floor (ontology only) [I] |
| 856 | so2 *(3.11.8)* | ppb | r | SO2 sensor (ontology only) |
| 1112 / 1113 | dropSpeedHMax / dropSpeedVMin *(3.11.8)* | — | rw | drop-detection thresholds (ontology only) [I] |
| 5202 | echo | Bool | w | echo input characters (text command `echo=0` is used instead) |

### 4.2 RR4 object (component id 1 when connected via its own port) [C unless marked]

| id | name | type | access | meaning / usage |
|---|---|---|---|---|
| 13 | components | List[Oid] | sub | list of networked component ids (contains the S2 when it is reachable) |
| 5 | name | String | get | "RR4" / "RR4_…" |
| 1201 | net | Struct (getVarType) | sub, get, set | radio settings. Windsond *reads* via SSP and *writes* frequency/timeslots/sampling/slot-length/max-data via **text commands** (5.4), and writes LoRa SF/BW/CR and ground-slot length via SSP `set net` with the complete struct |
| 774 | utcSyncSource | Uint8 | sub | time-sync quality (needed for encryption) |
| 599 | gnssHasAid | Bool | sub | "ephemeris available for download" |
| 598 | gnssGetAid | fn()→Blob | call (repeat) | returns the next chunk of GNSS aiding data (UBX-MGA frames); empty Blob = done; Windsond calls it up to 40 times with 1.5 s timeout each and concatenates |
| 1235 | encKey | REF104 | sub, get, set | encryption key (out of scope) |
| 596 | gnssSignals | map/list | sub | per-satellite C/N0 for the GNSS panel (`gnssId`,`satId`,`cno`,`flags`) |
| 628 | gnssEnabledConstellations | Uint8 bitmask | get, set | bit0 GPS, bit1 SBAS, bit2 Galileo, bit3 BeiDou, bit4 IMES, bit5 QZSS, bit6 GLONASS [I: bit order from the u-blox gnssId numbering used in the panel] |
| 24 | ping | fn | call | keep-alive |
| 477 | sspDefaultSet *(3.11.8)* | REF116 | get, set | present on auto-sync firmware (3.8.3+): the PC writes the desired S2 settings here once, the RR4 forwards them to each S2 (§5.5) |
| 1500–1507 | wifi* / ipAddr *(3.11.8)* | §1.8 | get, set, sub, call | WiFi configuration |
| — | own sensor data (`pa`, `alt`, `lat/lon`, `su`, `te`, `bat`) | — | — | **arrive as bracket messages with `role=6`** and via text commands `temp` / `bat` (5.4), not via SSP |

### 4.3 S2 object (component id as listed in `components`) 

| id | name | type | access | confidence | meaning |
|---|---|---|---|---|---|
| 5 | name | String | get | [C] | "S2" / "S2_…" |
| 1100 | md | Uint8 | sub (w [I]) | [C] | mode/phase: 0 init, 1 ready, 2 rising, 3 falling, 4 resting, 5 find-me, 6 find-me slow, 7 cutting down; **8/9 = charging (connected to USB/SA1)**; 8..11 = "not turned on"; 0..7 = "on". (Radio telemetry uses the same digits, plus `A` = rising above target, see 6.1) |
| 1200 | mac | Uint32 | sub | [C] | sonde number |
| 314 | bat | Float V | sub | [C] | battery voltage |
| 890 | pr | pascal | sub | [C] | current pressure |
| 891 | prCalOf | int pascal | get, set | [C] | pressure calibration offset; Windsond sets `old + (reference − measured)` |
| 336 | condition | Uint32 | sub | [C] | error/warning bitmap (6.3) |
| 587 | gnssEnabled | Bool | sub | [C] | GNSS powered (ephemeris upload only when true) |
| 1226 | txCriterion | Uint8 | sub, set | [C] | 0 = always send, 3 = require GPS fix (4 = require GPS, old 1PPS variant) |
| 1203 | power_dBm | int dBm | sub, set | [C] | post-launch TX power, GUI range −17 … +22 dBm |
| 1239 | powerBeforeLaunch_dBm | int dBm | sub, set | [C] | pre-launch TX power (only in "defence" builds of the GUI) |
| 1201 | net | Struct | sub, set | [C] | radio settings; Windsond copies the RR4's `net` value to the S2 ("Sent network settings to S2") when the S2 appears |
| 594 | gnssCmd | fn(Blob) | call | [C] | raw command to the u-blox GNSS; used for ephemeris upload (5.7) |
| 596 / 628 | gnssSignals / gnssEnabledConstellations | — | sub / get,set | [C] | GNSS panel; S2 cannot enable BeiDou and GLONASS together; at most two of {GPS+Galileo, BeiDou, GLONASS} |
| 1235 / 1241 | encKey / encUnlocked | — | get, set / get | [C] | encryption |
| **1105** | relAlt | Uint16 m AGL | rw | [I] | cut-down ("release") altitude above ground. In 3.8.0 the equivalent is sent over the text channel (`relAP=…`, 5.4) |
| **1103** | relPr | pascal | rw | [I] | release pressure |
| **1102** | burn | fn | call | [I] | fire the hot-wire (manual cut-down). Text equivalent: `relBal` / `relGnd` |
| **1104** | burnTest | fn | call | [I] | test hot-wire without cutting. Text equivalent: `wires` |
| **1107** | ledTest | fn | call | [I] | blink the power LED. Text equivalent (legacy): `led` |
| 1108 | burnShuntR | ohm | rw | [I] | shunt used for burn current measurement |
| 1101 | gs | — | rw | [I] | "ground station ready" flag (handled by the RR4 itself for S2; text `gs=0/1`) |
| 1106 | landedBehavior | enum | rw | [I] | behaviour after landing (text param `behlan`, set with `findme=<n>`: 0 power-save, 1 beacon at once, 2 continue sounding *(3.11.8)*) |
| 1109 | role | Uint8 | sub, set | [C] *(3.11.8)* | 1 reusable radiosonde, 2 one-time radiosonde, 3 dropsonde, 4 tethersonde (3.11.8), 6 receiver (text only). Windsond 3.11.8 subscribes it and changes it with `set` (3 attempts, 1 s); nack 5 = "S2 does not have role" |
| 1110 / 1111 | silentUntilReady / listenAfterReady | Bool | rw | [I] | behaviour flags |
| 1215 / 1216 | radioEnabled / radioPaused | Bool | rw | [I] (the software treats them as untyped Any) | radio on/off |
| 893 | baroTemp | °C | r | [I] | barometer IC temperature |

Variable types must be confirmed with `getVarType` (section 5.3); Windsond does exactly that for every symbol it subscribes to, and treats `radioEnabled`, `radioPaused`, `baroTemp` as "Any" when the S2 does not answer their type [C].

---

## 5. Procedures

### 5.1 Open port and handshake (text channel) [C]

1. Open COM port, 38400 8N1.
2. Send `echo=0\r\n`, wait up to 2 s for `[echo=0]` or `[]` (retry up to 5 times; then reopen port).
3. Send `mac\r\n` → `[MAC=<hex>]` (case-insensitive prefix `MAC=`, value hexadecimal = receiver MAC/serial). Retry up to 5 times; on persistent failure continue without MAC.
4. Send `about\r\n` → `[about="Sparv RR4 hw=<x>, fw=<y>, prot=<n>"]` (the quotes are part of the reply; may contain `\n`). `prot=5` or `prot=6` → "RR4 protocol 5/6" = multisond, LoRa, precise frequency, SSP link supported, ephemeris, temp/bat queries. `prot=4` → older RR4 (no LoRa fields, SSP link supported). Prefix `Sparv RR2`/`Windsond receiver` = legacy devices.
5. If SSP is supported, enable the SSP link (start probing, 5.2). The application is "connected" only after the network settings have been retrieved (5.4).

### 5.2 Join the SSP network [C]

1. Every ~3 s send a link-level CInfo (section 2.2) to `TO=0xFF` until a `newid`/`newidWithRev` addressed to `0xFF` arrives.
2. From the NewId: `tk` = id of the central (expect 1), `id` = our component id, `prio` = central priority, `name` = our new name ("" = keep "python"). If it was a `newidWithRev`, immediately send `newidAck{revision}` to `0xFF`.
3. Route: all non-local traffic goes to the neighbour; the central's id is in `tk`.
4. Keep-alive: see 1.6. If the NewId has a `prio` lower than ours (ours is 0) it is ignored — not relevant for a PC client.
5. On any loss of link: forget ids/routes/subscriptions and restart at step 1 (the RR4 will assign a new id; it may be the same).

### 5.3 Enumerate objects / discover the S2 [C]

1. `sub` to the central (id 1) for symbol 13 `components` (frame `01 12 <us> 01 0d`), wait ≤2 s for the first `rep` (retried up to 4 times).
2. For each oid in the list that is not 0 and not our own id: `uget name` (code 0x8F) and wait ≤1.5 s (up to 3 attempts). `RR4`/`RR4_…` → receiver object; `S2`/`S2_…` → sonde object. (Other objects may exist; ignore them.)
3. For the RR4 object: `getVarType` for `utcSyncSource, gnssHasAid, net, encKey` (≤2 s, 3 attempts), remember the schemas, then `sub` to the same symbols (≤2 s, 3 attempts). The first report delivers `net`.
4. The `components` subscription stays active: when the S2 later appears/disappears the central sends a new report; the S2 object is created/dropped accordingly. The S2 is "connected" when it is listed and answers.
5. For the S2 object: `getVarType` then `sub` for `gnssEnabled, md, mac, bat, net, condition, pr, txCriterion, power_dBm, powerBeforeLaunch_dBm` (3 attempts, 2 s) — *(3.11.8)* plus `role`; `encUnlocked`/`encKey` are read on demand. Retry the subscription if no report within the timeout. Then copy the RR4 `net` to the S2 with `set net` (5.5) — *(3.11.8)* only when the RR4 has no `sspDefaultSet` (5.5a).
6. Via SA1 cable the same sequence runs on the second port (57600 Bd) with the S2 itself as central (id 1): subscribe `components`, find the object named `S2…`, continue at step 5. When both exist, Windsond keeps using the object it saw first and switches sources only when that one disconnects (SA1 marked as "source used") [I]. *(3.11.8)* The direct SA1 link is no longer opened by the software; the S2 object is only looked for in the RR4's `components` [C].

### 5.4 Read and write receiver settings [C]

Reading: all values come from the `net` report (SSP) when SSP is supported. Mapping between `net` struct fields, text commands and GUI:

| Setting | `net` field (SSP) | Text get → reply | Text set | Range/validation in GUI | Written via |
|---|---|---|---|---|---|
| Radio frequency | `freq` (Hz, U32) | `frequency` → `[frequency=<Hz>]` (older RR4/RR2: `freq` → `[freq=<10 kHz units>]`) | `frequency=<Hz>` | 3.8.0: 400–440 MHz (390–440 with "wide" option), hard reject outside 400–450. *(3.11.8)* allowed span is a configuration: **default 400.000–440.000 MHz, extended 390.000–440.000 MHz**, optionally narrowed by a licence (mechanism not described); values outside the active span are rejected before sending [C] | **text** |
| Number of timeslots (TDMA sondes) | `radioTimeslots` (U8) | `ts` → `[ts=<n>]` | `ts=<n>` | ≥0; defaults 6 (or 16 in "16-slot" builds) | **text** |
| Sample period | `samplingInterval` (U16 ms) | `sample_ms` → `[sample_ms=<ms>]` | `sample_ms=<ms>` | ≥0; default 1000 (2000 in 16-slot builds) | **text** |
| Sonde slot length | `radioSlotMs` (U16 ms) | `sonde_slot_length` → `[sonde_slot_length=<ms>]` | `sonde_slot_length=<ms>` | default 500 (375) | **text** |
| Max payload | `radioMaxData` (U8 bytes) | `max_data` → `[max_data=<n>]` | `max_data=<n>` | — | **text** |
| Ground-station slot length | `radioGroundSlotMs` (U16 ms) | — | — | 0–65535 | **SSP set net** |
| LoRa spreading factor | `loraSpreadingFactor` (U8) | — | — | 6…12 | **SSP set net** |
| LoRa bandwidth | `loraBandwidth` (U8) | — | — | 0 = 125 kHz, 1 = 250 kHz, 2 = 500 kHz | **SSP set net** |
| LoRa coding rate | `loraCodingRate` (U8) | — | — | 1 = 4/5, 2 = 4/6, 3 = 4/7, 4 = 4/8 | **SSP set net** |
| Receiver beeps on packet | — | — | `rbeep=1` / `rbeep=0` | — | text |
| Receiver temperature/pressure | — | `temp` → `[temp=<°C>, pr=<Pa>]` (or `[Error…]`/`[Failed…]`) | — | — | text (polled every 1.5 s) |
| Receiver battery | — | `bat` → `[bat=<V>]` or `[<V>]` | — | — | text |
| Announce network to sondes ("Pair with sond") | — | — | `annNet` | — | text [C: command name; effect I] |
| Assign sonde number | — | — | `!.exe=mac=<number>` (broadcast execute) | — | text |

Write-and-verify procedure used by the software:
* Text settings: send `key=value`, accept the reply if it starts with `key=` and parses to the requested value (status "set confirmed"), otherwise "set failed"; on timeout keep the old value. Several settings in a row are spaced ≥0.2 s.
* SSP `net` settings: take the last received `net` struct, replace the field, `set` the **complete struct** with reply (code 0x91), wait ≤2 s for `reply` (ok) or `nack`; the new value is confirmed when the next `net` report (subscription) matches ("set pending" until then).
* After any change the S2 (if connected) is updated by `set net` with the RR4's struct — *(3.11.8)* or, on auto-sync firmware, by re-writing `sspDefaultSet` (5.5a).

The session file `windsond_sessions.dat` stores a string identifying the settings (`freqMHz:ts:sample_ms:slot_ms:max_data:ground_slot:sf:bw:cr`, "-" for disabled fields) so a change can be detected across restarts.

### 5.5 Settings on the S2 [C]

* `txCriterion`: `set` 0 (always send) or 3 (require GPS); the software first `get`s it and only sets on difference.
* `power_dBm` / `powerBeforeLaunch_dBm`: `set` an integer dBm, read back with `uget` to confirm.
* `net`: `set` with the RR4's struct (see above).
* `prCalOf` (pressure calibration): `uget prCalOf` (≤1 s), then `set prCalOf = old + round((reference_hPa − measured_hPa)·100)` (≤2 s); reference is either the RR4's own pressure or a user value.
* GNSS constellations: `uget gnssEnabledConstellations` (0.5 s, 3 attempts) then `set` the bitmask after validation (see 4.3).
* *(3.11.8)* `role`: `set role = 1|2|3|4` (3 attempts, 1 s) to change a connected S2's role.
* *(3.11.8)* Retries for single-variable get/set on the S2: 0.5 s, 1 s, 1.5 s; after `set power_dBm` / `powerBeforeLaunch_dBm` the value is read back and a differing value is reported as "clamped".

### 5.5a RR4 auto-sync of S2 settings — `sspDefaultSet` (3.11.8) [C]

RR4 firmware from early 2026 exposes variable 477 `sspDefaultSet` (type REF116):

```
Tuple( opt : Uint64 ,  defaults : NameMap{ net: NetworkV6 (REF105), txCriterion: U8, power_dBm: I16,
                                           powerBeforeLaunch_dBm: I16, encKey: EncryptionData (REF104) } )
```

* On RR4 connect, after the subscriptions: if `getVarType` listed `sspDefaultSet`, `uget` it (0.5/1/1.5 s retries) and compare: `net` against the RR4's current `net`, the other entries against the user's desired values ("leave unchanged" = entry omitted), `encKey` against the RR4's key when key sync is on. On any difference `set` the rebuilt tuple.
* `opt` is a bit mask over the map entries in insertion order; bit *n* set = entry *n* is optional (the S2 need not support it). Windsond sets the bit for `encKey` with an empty payload (= clear the key) and always for `powerBeforeLaunch_dBm` [C for the bits, I for the firmware semantics].
* When the RR4 has `sspDefaultSet` the PC **does not write any setting to the S2**; the RR4 pushes them to every S2 that appears (including after a sonde swap). Without the variable the 3.8.0 per-variable push (`set net`, `txCriterion`, `power_dBm`, `powerBeforeLaunch_dBm`, `encKey` when `encUnlocked`) remains.

### 5.6 Set frequency / timeslots

Frequency and timeslots are **receiver** settings (5.4); the sonde adopts them when the RR4's `net` is pushed to the S2 over SSP (cable or radio) or by the RR4's network announcement. There is no per-sonde frequency command in 3.8.0.

### 5.7 Ephemeris (GNSS assistance) transfer [C]

Two sources, same upload path:

A. **From the RR4's GNSS** (no internet): when `gnssHasAid` is true, call `gnssGetAid` on the RR4 repeatedly (≤40 calls, 1.5 s each) and append every returned Blob until an empty Blob (or a non-Blob) is returned; abort if the total is empty. Cache the result (download timestamp shown in GUI).

B. **From u-blox AssistNow Online** (internet): HTTPS GET to `online-live1.services.u-blox.com` (fallback `online-live2…`) with parameters `token=<vendor token – not disclosed>`, `gnss=gps`, `datatype=eph,alm,aux,pos`, `lat`, `lon` (3 decimals), `alt`, `pacc` (position accuracy in m, 300000 default). The response body is a concatenation of UBX frames.

Upload to the S2 (requires S2 connected, `md` < 8 i.e. turned on, `gnssEnabled` true, and the upload enabled by the user):

1. Split the data into UBX frames: each frame length = 6 + payload length (little-endian U16 at bytes 4–5) + 2.
2. Prefix every frame with one byte `0xFF`.
3. Cut every prefixed frame into chunks of **≤50 bytes** and send each chunk as `call gnssCmd(Blob chunk)` with reply (ticket), timeout 2 s, **one retry** per chunk (3.8.0) / **up to 5 attempts** per chunk *(3.11.8)*; abort the whole upload when a chunk still fails and retry the whole procedure not earlier than 60 s later; a successful upload is not repeated within 300 s *(3.11.8)*.
4. Success is logged with a timestamp; "recent upload" prevents re-upload for a while.

The S2 reassembles the chunks and feeds the UBX-MGA messages to its receiver [I].

### 5.8 Sonde commands over the text channel (LED test, burn test, manual cut-down, mode, parameters) [C]

Commands to a sonde are sent to the RR4 as

```
<sonde_number>.exe=<command>\r\n      → expects a response (RES message)
<sonde_number>.cmd=<command>\r\n      → one-way, no response
!.exe=<command>                        → broadcast
```

The RR4 forwards the text over radio in the sonde's next time slot; the sonde's answer arrives as `[#RES:…:<text>]` (possibly several parts with `part=…`, the last without), or `[#TIM:]` when the radio exchange timed out. Only **one command per sonde at a time**; the software waits **8 s** for the response, then marks it as timed out, and keeps ≥0.2 s between sends and ≥1 s between automatic commands to the same sonde; a `RES` that starts with `Busy`/`BUSY` means the sonde is busy (retry later), `Error…` is an error answer.

Commands issued by Windsond 3.8.0 (S2 = "multisond" mode unless marked *S1 only*):

| Command | Purpose | Response/notes |
|---|---|---|
| `relBal` (or `relBal=150`, `relBal=<ms>`) | **manual cut-down** (fire primary hot-wire). `relBal=150` is sent while the sonde is in init/ready/resting/find-me; plain `relBal` for firmware ≥170 in flight. *(3.11.8)* **For an S2 in flight (rising / falling / cutdown / rising-too-high) Windsond sends `mode=7` instead of `relBal`** (3.9.0 "cut-down now delay" fix); `relBal=150` on the ground is unchanged [C] | text in RES; later a `TXT` message `C(...)` "cut-down report" and `w(...)` "wire heated" events |
| `relGnd` | second cut-down (secondary wire, "Cut-down 2nd now!") | *(3.11.8)* the action counts as confirmed only when the RES text starts with `C` (the sonde's cut-down report); any other RES = "received invalid response" (3.11.7) [C] |
| `wires` | **test the cut-down wires and the LED** without cutting (burn test). Sent one-way; the sonde replies with a `TXT` message `R(S<n>B<n>C<n>L<n>…)` | letters: `S` primary wire, `C` secondary wire, `B` battery/voltage, `L` LED; values decoded as current/resistance (S: `I=n/100 A`), status words "OK"/"Doesn't work!"/"Not configured" are derived by thresholds in the GUI. *Automatic wire checks are not performed for S2.* |
| `beep=2900` | make the sonde beep (2900 Hz) | — |
| `mode=<n>` | set mode (0 init, 1 ready, 2 rising, 3 falling, 4 resting, 5 find-me, 6 find-me slow, 7 cutdown). Windsond sends `mode=5` to wake a sonde reporting mode 4 or 6 | — |
| `findme=<n>` | behaviour after landing (parameter `behlan`: 0 power-save, 1 beacon at once, 2 continue sounding *(3.11.8)*) | — |
| `params=<id>[,<id>…]` | **query parameters by numeric id**; ids are two digits (`04`, `06`, `13`, `15`, `17`); command length ≤21 chars; the sonde answers by including the parameters in its next packets (`role`, `fwver`, `behlan`, `cutalt`, `supmul`…) | ids: 4 behlan, 6 role, 13 fwver, 15 cutalt, 17 supmul |
| `groundAlt=<m MSL>` | ground altitude for the sonde's AGL calculations (param `galt`) | *S1 only (removed for multisond)* |
| `grPres=<Pa>` | ground pressure (param `gpa`), even number | *S1 only* |
| `relAP=<pressure/2>:<alt AGL>` | **cut-down altitude**, sent as half the release pressure in Pa and the altitude AGL in m | *not sent automatically in multisond mode; it is the `set_cmd` of the `cutalt` parameter when the user edits it* [C for format, I for S2 acceptance] |
| `power=<0..7>` | sonde TX power index (1.3/1.5/3/6/13/25/50/100 mW) | legacy (S1); *(3.11.8)* no longer offered for an S2 (S2 power only via SSP `power_dBm`) |
| `gs=0` / `gs=1` / `gs=1s<slot>` | ground-station handshake: "ready" (optionally assigning time slot) / "back to init" | *S1 only; for S2/RR4 the receiver does this itself* |
| `led`, `ver`, `gpsQuality`, `releaseAlt`, `gndAP`, `iparam` | legacy S1 queries seen in demo logs; `<sid>.cmd=iparam` asks a sonde known only by session id for its number (*S1 only*) | — |
| `updaterate=<ms>`, `supmul=<n>`, `tempB=<n>`, `tempR0=<n>`, `autolog=<0-2>`, `gpslog=<n>`, `log=c` / `log=s` / `log=p` | legacy S1 firmware settings | — |

The command set accepted by the **S2 firmware** is not listed anywhere in the analysed software beyond the above; see open questions.

### 5.9 Arm / start and launch detection [C]

* For RR4 + S2 ("multisond") the PC does **not** arm the sonde: the RR4 assigns TDMA slots and answers the sonde's ready handshake itself. The PC only needs correct, matching `net` settings on RR4 and S2 (push with `set net`, or cable-sync) and then listens.
* The S2 announces itself with a bracket message carrying `id=<sonde number>` (and `sid=<slot>`); the PC creates a sounding object keyed by `id` (session id `sid` is informational for S2). `id=255`/`65535` = "uninitialised unit online".
* Launch detection is done on the PC from the data (6.2); the sonde's own `md` changes to 2 (rising) when it detects launch itself.

### 5.10 Live telemetry (bracket messages) [C]

Format: `[#<TYPE>:<k>=<v>,<k>=<v>,…[:<data>]]` — exactly up to three colon-separated parts (type, parameter list, free data); parameter values never contain `,` or `:`.

| TYPE | Meaning |
|---|---|
| `DAT` | data packet (one sample) |
| `MET` | meteorological multi-sample packet (S2/LoRa): contains the current values plus history samples `spd1…9`, `ang1…9`, `te1…9`, `hu1…9` taken 1…9 sampling periods earlier; the PC expands them into inferred samples (type `INF`) spaced by `samplingInterval`, pressure linearly interpolated from the previous packet with pressure (≤22 s old) |
| `PK` | packet metadata (link quality only: `rssi`, `rec`, `hderr`, `bderr`, `crc`, `net`) |
| `RES` | response to an `exe` command (`part=` for partial) |
| `TXT` | text message from the sonde: data part `X(…)` with `X` = `C` cut-down report, `R` wire-test status, `w` wire heated; inner letters+numbers are decoded as a letter→integer map |
| `ANN` / `ANET` | announcements (sonde online / network announce) |
| `TIM` | radio timeout of the pending command |
| `FIND` | find/discovery |
| `TST` | link test packet (`typ`, `err`, `tot`, `afc`, `rssi`) |
| `CMD` | command echo |

Parameter keys and conversion rules [C]:

| key | type | meaning / conversion |
|---|---|---|
| `id` | int | sonde number (MAC) |
| `sid` | int | session id = TDMA slot |
| `seq` | string/int | packet sequence number |
| `role` | int | 0 undefined, 1 reusable radiosonde, 2 one-time radiosonde, 3 dropsonde, **6 = the receiver's own data** |
| `md` | string | mode digit `0`–`7`, `A` = rising above target (see 6.1) |
| `lat`, `lon` | float str | WGS-84 degrees (full position); `0` = invalid |
| `latm`, `lonm` | int | only the minute part: value/600000 degrees, needs a reference position (older sondes) |
| `latd`, `lond` | int | only the decimal part of the minutes: value/10000/600000 degrees |
| `new` | `0`/`1` | GPS fix is new (absent = treated as `1`) |
| `alt` | float | **GPS altitude** m MSL (stored as `gps_alt`; the key `alt` is then reused for the pressure altitude computed on the PC) |
| `pa` | int | pressure Pa (copied to `pr`) |
| `te` | float | air temperature °C; values > 400 wrap: `te − 655.36` |
| `te1…te7` | float | history temperatures, same wrap |
| `tei` | float | internal temperature °C (`64.00` = sensor absent → key removed) |
| `tmp2` | float | second temperature |
| `hu` | float | relative humidity % |
| `spd` | float | ground speed m/s |
| `ang` | float | course (track) degrees true (`ang1…5` history, negative values + 327.68) |
| `su` | float | supply/battery voltage V |
| `rise` | float | rise rate m/s (from the sonde) |
| `q`, `q0`, `q1` | hex byte | RSSI raw (0–255); `rssi = q/256` normalised 0..1; `q = max(q0,q1)` when both present |
| `r` | int | RSSI raw (alternative key): `rssi = r/256` |
| `rs`, `snr` | int (3.8.0) / **float** *(3.11.8, decimals allowed)* | RR4 ("precise RSSI"): `rs` = RSSI dBm, `snr` = SNR dB; normalised `rssi = clamp((rs+snr+140)/90, 0, 1)` |
| `rec`, `rec0`, `rec1` | int | corrected (recovered) bits; quality `qu = max(0.01, rssi − 0.02·rec)` |
| `hderr`, `bderr`, `crc` (`S` = body) | int/str | header/body error counts (PK) |
| `afc`, `afc0`, `afc1` | int | AFC offset (Hz·1000 shown as kHz) |
| `pwr`, `gpse`, `behlan`, `logst`, `clk`, `resq`, `evt`, `fwver`, `mcnt`, `cutalt`, `cutpr2`, `supmul`, `gpa`, `galt`, `hw`, `burn`, `ucnt`, `tim`, `ctmr`, `net`, `twire`, `blk`, `beep`, `gpss`, `lux`, `sats`, `hdop`, `ce`, `enc`, `loss` | int | sonde parameters/status: `pwr` TX power index, `behlan` landed behaviour, `fwver` firmware, `cutalt` release altitude AGL m (65535 = none), `cutpr2`, `gpa` ground pressure, `galt` ground altitude, `hw` hardware, `burn` burn status, `lux` light, `sats` satellites, `hdop`, `enc` encryption (`1` enabled), `loss` missed updates |
| `evt` | int | event: 1 autorelease, 2 max-alt, 3 boot watchdog, 4 boot, 5 landed [I: order from GUI labels] |
| `jam`, `spoof` *(3.11.8)* | int | GNSS integrity flags of the sonde: 0 none, 1 suspected (GUI: "Possible GNSS jamming/spoofing detected", remembered for 300 s), 2 detected (GUI: "Jamming / spoofing detected") [C for the levels, I for the wording] |

*(3.11.8)* Typed key sets of the original parser: integers `pwr gpse behlan logst role clk resq evt fwver mcnt cutalt cutpr2 supmul gpa galt hw burn ucnt tim rssi ctmr net twire blk beep gpss id sid r rec rec0 rec1 pa lux afc afc0 afc1 jam spoof`; floats `su ang spd te tei hu alt rs snr`; hex `q q0 q1`; everything else text. A parser should accept decimals in any numeric key (3.11.3 "radio quality parameters with decimals").

Example (S1, from the shipped demo): `[#DAT:q=73,afc=15310,seq=29,su=4.09,te=19.50,md=0,pa=98634,hu=62.89,tmp2=22.40]`. Exact key set emitted by the S2/RR4 pair is not present in the material (see open questions).

### 5.11 Radio scan

The frequency scanner (`specan=<start>,<step>,<count>,1`, reply `rf_spec <hex per step>`, RSSI dBm = 0.5·byte − 120, 10 kHz frequency units, 1.2 s per request, 3 retries) is **enabled only for RR2 receivers** in 3.8.0 (`has_freqscan`) [C]. Whether the RR4 accepts `specan` is unknown.

### 5.12 Graceful close [C]

Unsubscribe is optional (Windsond simply stops); it does `unsub` only when a GUI panel is hidden. On close: stop the timers, send nothing, close the port [C]. The RR4 presumably drops the PC component once the keep-alive pings stop [I]. A new app may send `unsub` for all subscriptions and then close the port.

---

## 6. Sonde states, launch detection, indicators

### 6.1 Mode values (sonde-reported `md`) [C]

| md | name | GUI text |
|---|---|---|
| 0 | init | "Waiting for GPS fix" |
| 1 | ready | "Ready to launch" / "Ready for drop" |
| 2 | rising | "Ascent at … AGL" |
| 3 | falling | "Falling …" |
| 4 | resting | "Lying silent on the ground" |
| 5 | find-me | "Beeping to help recovery" |
| 6 | find-me slow | "Beeping slowly to help recovery" |
| 7 | cutdown | "Trying to do cut-down" |
| `A` (text telemetry) | rising too high | "Rising too high" (above target altitude); SSP numeric equivalent unknown (10?) [U] |
| 8, 9 (SSP only) | charging | "S2 is charging" (USB/SA1 connected) |
| 8–11 | — | "S2 not turned on" (no ephemeris upload) |

Capability letters (legacy S1: returned after the firmware version by the `ver` command, e.g. `1.65 HTBR`): `T` second temperature, `H` HIH5030 humidity, `B` barometer, `S` SHT75, `R` release-balloon-2, `O` one-time sonde [C for the letter meanings; the mechanism is not exercised for S2 in 3.8.0].

### 6.2 PC-side adjusted state machine (how Windsond decides the phase) [C]

Per new data message (altitude `alt` = pressure altitude when a barometer is present, else GPS altitude):

1. **Launch report**: for a radiosonde, once the sonde is > 35 m above ground altitude, the launch report is the latest earlier report that is *not* ascending.
2. **Highest report** = running maximum of `alt`; **peak** is declared when a later report is more than 20 m below the highest.
3. Adjusted mode (`mode`), starting from the reported `md`:
   * if `md` ∈ {ready, rising, falling}, `alt` > launch alt + 50 m and `rise` > −0.5 m/s → **RISING**; if `rise` < −3 m/s → **FALLING**;
   * if the sonde is 100 m below the highest point for > 30 s while reporting init/ready/cutdown/rising/falling, and |`rise`| < 1 m/s → **RESTING** (landed);
   * if RISING and `alt` > ground + release altitude → **RISING_TOO_HIGH**;
   * dropsonde: FALLING after a sudden descent (`rise` ≤ −6 m/s) is found.
4. Automatic actions (multisond): sonde in RESTING or FINDME_SLOW → send `mode=5` (wake up / beep). All other automatic commands (`gs=…`, `relAP`, `wires`, ground-altitude query) are S1-only.
5. "No contact" is displayed after 2 × timeslot period (timeslots × slot ms) without a message. *(3.11.8)* S2: `radioTimeslots × radioSlotMs` (fallback 3000 ms); S1: the configured expected data rate.
6. *(3.11.8)* Role is dynamic: the `role` parameter reported by the sonde (`params=06`) decides radiosonde vs dropsonde; 0/absent → capability letter `O` = one-time radiosonde, else the configured default. GNSS integrity: `jam`/`spoof` (5.10) plus a PC-side check of GNSS altitude against pressure altitude (`sw_spoof`).

### 6.3 S2 `condition` bitmap [C]

Errors (bit n set, n = 0…10): 0 hardware error, 1 missing GPS or comm, 2 temp/RH sensor error, 3 external sensor error, 4 radio hardware error, 5 missing/broken flash, 6 pressure sensor error, 7 battery error, 8 **cut-down test failed**, 9 corrupt/full memory, 10 light sensor error.
Warnings (bit 16+n, n = 0…7): 0 missing sensor calibration, 1 no time source, 2 no GPS fix, 3 low memory, 4 low battery, 5 sensors not ready, 6 no radio contact, 7 initialising.
`0` = "Everything OK".

### 6.4 LED blink codes

Not contained in the analysed material (only `ledTest` and the `L` field of the wire test). Open question.

### 6.5 Battery / status thresholds used in the GUI [C]

Battery (S1 lithium): OK ≥ 3.95 V, warning ≥ 3.75 V, error below; alternative chemistries (2.35/2.25 V and 3.4/3.0 V) are selected by voltage range. Pressure plausible range 80000–105000 Pa on the ground. GPS: fewer than 6 satellites = note.

---

## 7. Files written by Windsond

File base name: `<YYYY>-<MM>-<DD>_<HHMM>` of the sounding start (local time), optionally `_<sondenumber>` (setting "include id in file names"), with `_<n>` appended if the name exists. Default directory `My Documents\Windsond files` (configurable) [C].

### 7.1 `<base>.sounding` — raw log (replayable) [C]

```
# Session start 2025-10-13 09:12:05
# offset=1760339525.123          (float, unix time of start; all line timestamps are relative to it)
# timezone=7200                  (seconds east of UTC, -(time.timezone))
# version=4
# receiver version=Sparv RR4 hw=…, fw=…, prot=5     (the 'about' line)
# receiver mac=123456            (decimal; line only present when known)
# net_settings=6:500:1000        (timeslots:slot_ms:sample_ms, '-' when unknown)
# install=<install id> <licensee id>
# software=A3.8.0
# node_id=12345                  (sonde number; omitted in the unified multi-sonde file, which has '# unified=true')
00m00s000: [#DAT:…]
00m00s203: # ENQUEUE: gs=1
00m00s250: # EXE_NOW: relBal
00m00s797: [#RES:q=64:]
00m00s797: # REPLY to relBal: 
1h02m03s456: [#MET:…]
```

* Each line = timestamp `[-][hh h]mm m ss s mmm: ` + payload. Payload is either a bracket message exactly as received (escaped; non-printables as backslash escapes) or `# comment` (`ENQUEUE:`, `ENQUEUE_ONEWAY:`, `EXE_NOW:`, `REPLY to <cmd>: <text>`, `TIMEOUT dongle: <cmd>`, `TIMEOUT python: <cmd>`, `BUSY`, `SET site <name>`, `STOP`).
* Parsers accept version ≤ 4; the `id=<node_id>` parameter is removed from stored messages of per-sonde files and re-inserted on load [C].
* `windsond_sessions.dat` (in the data dir): `#File is automatically generated by Windsond. Don't edit.`, `#version=2`, `#settings=<settings string>`, then lines `<id>, <sid>, <last_contact unix>`; entries older than 6 h are dropped [C].

### 7.2 `<base>.raw_flight_history.csv` (consumed by s2stueve) [C]

Written only after a launch report exists **and** the ground altitude is known; rows start at the launch report; the file is rewritten from scratch when the launch report or ground altitude changes. One row per data message (`DAT`, `MET`, inferred `INF`) that contains `alt` and `pr` and at least one of `spd`, `ang`, `te`, `hu`. Values are the **unfiltered** readings (no radiation correction; `te` as received).

Header line (exact):

```
UTC time, Altitude (m MSL), Altitude (m AGL), Pressure (Pascal), Speed (m/s), Heading (degrees), Temperature (C), Relative humidity (%), Internal temperature (C), Latitude, Longitude, Rise speed (m/s)
```

Row construction (separator is `, ` = comma + space; the row ends with `\n`, no trailing separator):

| # | Column | Format | When missing |
|---|---|---|---|
| 1 | UTC time | `YYYY-MM-DD HH:MM:SS` (UTC, from the PC receive timestamp) | — |
| 2 | Altitude (m MSL) | `, %i, ` of `alt` (pressure altitude; GPS altitude if configured) | `,  , ` (two spaces) |
| 3 | Altitude (m AGL) | `%i, ` of `alt − ground_altitude` | ` , ` |
| 4 | Pressure (Pascal) | `%i, ` of `pr` | (row not written) |
| 5 | Speed (m/s) | `%.2f, ` of `spd` | ` , ` |
| 6 | Heading (degrees) | `%.2f, ` of `ang` (course over ground, **true**, not the wind source direction) | ` , ` |
| 7 | Temperature (C) | `%.2f, ` of `te` | ` , ` |
| 8 | Relative humidity (%) | `%.2f, ` of `hu` | ` , ` |
| 9 | Internal temperature (C) | `%.2f, ` of `tei` | ` , ` |
| 10–11 | Latitude, Longitude | `%.6f, %.6f, ` when the message has a valid position | ` ,  , ` |
| 12 | Rise speed (m/s) | `%.1f` of `rise`; `0.0`/`-0.0` written as `0` | empty |

Example row: `2025-10-13 07:15:02, 1234, 812, 87651, 4.52, 213.40, 3.21, 54.20, 21.50, 47.123456, 8.654321, 4.8`

*(3.11.8)* Header text and the altitude / speed / temperature values follow the configured display units: `Altitude ({m|ft} MSL)`, `Speed ({m/s|kt|km/h|mph})`, `Temperature ({°C|°F|K})`, `Rise speed ({m|ft}/s)`. With the default metric settings the only difference to the header above is **`Temperature (°C)` / `Internal temperature (°C)`** (UTF-8 degree sign) [C]. s2stueve matches `Altitude (m MSL)` and a column starting with `Temperature`, so metric 3.11.x files parse and imperial ones are rejected; S2 Ground keeps writing the 3.8.0 header.

Sister formats: `.raw_history.csv` (same columns, header says `Temperature (uncorrected C)`, starts at message 0, only requires `pr`), `.raw.csv` (`Altitude (m MSL), Pressure (Pascal), Speed (m/s), Heading (degrees), Temperature (C), Relative humidity (%)`, only rows with increasing altitude, `%i, %i, %.2f, %.2f, %.2f, %.2f`), `.multi_sond_history.csv` (`time=<unix>, id=<n>, lat=, lon=, temp=, hum=, …` lines with a `# Log version=1` / `# Software version=` header; also streamable to UDP port 12345).

### 7.3 Template-driven sounding CSV (`fileformat_<name>.txt` → `<base>.<name>`) [C]

Configuration file keywords: `description=`, `header_text=`, `suppress_header`, `default_active`, `use_actual_reports`, `altitude_agl_m=<list>`, `altitude_agl_ft=<list>`, `altitude_agl_spacing_m=`, `altitude_agl_spacing_ft=`, `remove_data_before_gps_fix`, `remove_data_before_take_off`, `remove_data_after_first_landing`, `remove_data_after_peak`, `remove_data_at_recurring_altitudes`, `column_separation=comma|tab|semicolon|fixed-width`, `empty_value=`, then one column label per line (optionally `Label=Custom header`). The shipped `fileformat_sounding.csv.txt` produces `<base>.sounding.csv`:

```
# Radiation correction S2H3 v1.0            (1st comment line: text describing the active T/RH correction,
                                             "No correction." when disabled, "Radiation correction v3" for S1;
                                             when magnetic headings are used the line continues with
                                             ", mag_dec=<declination %.2f>")
# <header_text from the template>            (optional 2nd comment line)
Height (m AGL), Pressure (mb), Temperature (C), Relative humidity (%), Wind speed (m/s), Wind direction (true deg)
```

with rows every 20 m AGL (interpolated/filtered values from launch to peak). Available column labels: `Index`, `Time from launch (sec)`, `Reception quality (%)`, `Rise speed (m/s)`, `Temperature (C)`, `Virtual temperature (C)`, `Uncorrected temperature (C)`, `Relative humidity (%)`, `Uncorrected humidity (%)`, `UTC time`, `Local time`, `GPS altitude (m MSL)`, `Altitude (m MSL)`, `Altitude (ft MSL)`, `Height (m AGL)`, `Height (ft AGL)`, `Pressure (mb)`, `Pressure (Pa)`, `Wind speed (m/s)`, `Wind speed (kt)`, `Wind speed (km/h)`, `Unfiltered wind speed (m/s)`, `Wind direction (true deg)`, `Unfiltered wind direction (true deg)`, `Wind heading (true deg)`, `Wind heading (magnetic deg)`, `Unfiltered wind heading (true deg)`, `Unfiltered wind heading (magnetic deg)`, `Dew point (C)`, `Mixing ratio (g/kg)`, `Density (kg/m3)`, `Latitude`, `Longitude`, `Light level (lux)`, `Internal temperature (C)`, `NO2 blind (mV)`, `NO2 seeing (mV)`, `NO2 temperature (mV)`. Wind direction = course + 180° (mod 360); magnetic variants subtract the declination; lat/lon `%.6f`; wind direction `%.1f`.

### 7.4 KML [C]

`<base>.kml` (Google Earth, kml 2.1): styles `now`, `red_arrow`, `yellow_arrow`, `home`, `top`, `track`; a `Launch <name>` placemark, a `Flight Path <name>` LineString (`<lon>,<lat>,<alt>` per line, `extrude`), `Location now (AGL …)`, `Peak (AGL …)`, and landing-estimate placemarks; altitude mode `absolute`/`relativeToGround`. Companion files `windsond_reloading.kml` (NetworkLink refreshing every 15 s) and a units file linking all active sondes (refresh 5 s). Timestamps `YYYY-MM-DDTHH:MM:SSZ` (local time despite the Z).

---

## 8. Open points — to verify with hardware

1. **S2 SSP write/calls**: does the S2 accept `set relAlt`, `call burn`, `call burnTest`, `call ledTest`, `set md` over SSP (via RR4 and via SA1)? Expected reply format? (Windsond uses text commands instead.) → Test: `getVarType`/`funcSigs` on the S2, then try the calls on the ground with no balloon attached.
2. **Which text commands does the S2 firmware accept** through `<id>.exe=`? Confirmed in the software only: `relBal[=…]`, `relGnd`, `wires`, `beep=2900`, `mode=<n>`, `params=<ids>`, `relAP=<p/2>:<alt>` (user-triggered), `findme=<n>`. → Test each and record RES text.
3. **Exact `DAT`/`MET`/`PK` key set emitted by RR4 protocol 5/6** for an S2 (does it send `lat/lon` full, `rs/snr`, `rise`, `md`, `pa`, `tei`, `sats`, `enc`, `rec`?). → Capture a few minutes of raw serial log.
4. **`net` schema**: does the RR4 answer `getVarType net` with REF105 (no netId) or REF102? Does the S2 use the same? → Read with getVarType.
5. **Inner map type in reports** (`rep.map[oid]`): REF31 NameMap (0x1F) or generic Map (0x16, symbol keys then expBin-tagged)? The decoder must accept both. → Capture.
6. **`about` reply exact format** (`hw=`, `fw=`, `prot=` separators) and the `mac` reply (`[MAC=…]` hex). → Capture.
7. **`annNet` semantics** (what the RR4 broadcasts, how long, whether sondes must be in init mode). → Test with S2 in init.
8. **Sonde type strings** `S2H3-R-B20` / `S2H3-S-C1-B9`: where are they readable (SSP `name`, `class`, `fwVerStr`, `hw` param, `params=` reply)? Not present in the software.
9. **LED blink codes** of the S2: not in the material.
10. **md values 8–11** over SSP (8/9 charging confirmed; 10/11 unknown; `A` in text = 10?).
11. **`relAlt` unit/encoding** on the S2 (Uint16 m AGL? 65535 = disabled?) and whether the sonde recalculates `relPr` itself.
12. **Timing**: minimum spacing of `exe` commands per sonde with LoRa TDMA (software uses ≥1 s and 8 s response timeout); confirm the slot period = `radioTimeslots × radioSlotMs`.
13. **Ephemeris chunking**: does the S2 require exactly ≤50-byte chunks and the leading `0xFF`? Any acknowledgement content in the `reply`?
14. **Radio scan** (`specan`) on RR4: unsupported in the GUI; check if the firmware answers.
15. **Keep-alive**: does the RR4 drop a PC component that never pings, and after how long?
16. **`gnssGetAid` blob boundaries**: are chunks cut at UBX frame boundaries or arbitrary (the PC concatenates everything, then splits by UBX length)?
17. **SA1 cable**: confirm 57600 Bd and that the S2 is central (id 1) with the S2 object named `S2…` in its own `components` list.
18. **`pr` and `bat` SSP types** (Float vs fixpoint) → getVarType.
19. *(3.11.8)* **WebSocket endpoint** of the RR4: with `wifiEnabled=true, wifiAp=true` join the AP, read `ipAddr` over USB, probe `ws://<ip>/`, `ws://<ip>/ws`, `ws://<ip>:81/`, `ws://<ip>:8080/` (plus a TCP port scan); which one answers the binary CInfo probe with a NewId?
20. *(3.11.8)* **Text channel over WiFi**: are bracket lines / `<id>.exe=` available over the WebSocket (text frames) or a raw TCP port? Windsond's library would ignore text frames.
21. *(3.11.8)* **`sspDefaultSet`**: `getVarType` (expect REF116); set `(0, {net})`, read back, confirm a freshly powered S2 adopts the RR4's `net` without the PC pushing it; test an optional entry.
22. *(3.11.8)* **`mode=7` as cut-down** on an S2 in mode 2/3 (ground test, no balloon): fires the wire? RES text? Compare with `relBal`.
23. *(3.11.8)* **`relGnd` RES text**: exact RES of a successful secondary cut-down (expected `C(…)`) and of an unconfigured secondary wire.
24. *(3.11.8)* **`role=4`** (tethersonde): accepted by the S2 firmware? Behaviour?
25. *(3.11.8)* **`jam`/`spoof`**: value range and message types in which they appear.
26. *(3.11.8)* **`findme=2`**: accepted? `behlan` read-back?
27. *(3.11.8)* **390–400 MHz**: does the RR4 accept `frequency=395000000` (prot 6)?
28. *(3.11.8)* **CSV header** of a metric 3.11.8 installation (`Temperature (°C)`, UTF-8) — confirm and check s2stueve.
