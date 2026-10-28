// SSP-BIN codec (spec docs/protocol/ssp-windsond-protocol.md §1.4, §2, §3).
// Pure functions, no I/O. `encodeFrame`/`decodeFrame` turn a message object into the hex line
// body ("0x…") and back. Every decoded frame re-encodes byte-exact: values whose wire type is not
// the encoder's default choice are wrapped in `Typed` (type tag + value) and symbols in `Sym`.
// Why so much ceremony: the protocol has no length/CRC (§1.4); the only integrity check we get is
// that the whole line decodes without leftover bytes, so the decoder is strict and throws
// descriptive errors (the caller never lets that crash the reader loop).

export const T = {
  NULL: 0, BOOL: 1, U8: 2, U16: 3, I16: 4, I32: 5, U32: 6, FLOAT: 7, SYMBOL: 8, STRING: 9, BLOB: 10, SCHEMA: 11,
  CONSTANT: 12, TYPED_MAP: 13, STRUCT: 14, TUPLE: 15, TYPED_LIST: 16, TYPED_LIST_N: 17, CONCAT: 18, FIXPOINT: 19,
  EXTEND: 20, ANY: 21, MAP: 22, SCALED: 23, LIST: 25, REF: 26, I64: 27, U64: 28, UNION: 250,
};
const isFormat = (x) => x >= 12 && x <= 23 && x !== 21 && x !== 22;

// ---- schema constructors (JS-side descriptions of §3.2 formats) ----------------------------
export const S = {
  typedMap: (k, v) => ({ f: T.TYPED_MAP, k, v }),
  struct: (fields) => ({ f: T.STRUCT, fields }),            // [[name, schema], …]
  tuple: (items) => ({ f: T.TUPLE, items }),
  list: (of) => ({ f: T.TYPED_LIST, of }),
  listN: (n, of) => ({ f: T.TYPED_LIST_N, n, of }),
  fix: (signed, bits, decimals) => ({ f: T.FIXPOINT, signed, bits, decimals }),
  scaled: (bits, signed, scale, offset) => ({ f: T.SCALED, bits, signed, scale, offset }),
  union: (keyType, options) => ({ f: T.UNION, keyType, options }),
};

// ---- registry: shared schemas (REF entries, spec §3.3 / symbols.json "registry") -------------
export const REGISTRY = {
  31: S.typedMap(T.SYMBOL, T.ANY),                       // NameMap
  32: S.fix(0, 16, 1), 33: S.fix(0, 16, 2), 34: S.fix(0, 16, 3), 35: S.fix(1, 16, 1), 36: S.fix(1, 16, 2),
  37: S.fix(1, 16, 3), 38: S.fix(0, 32, 3), 39: S.fix(1, 32, 1), 40: S.fix(1, 32, 6),
  41: S.tuple([T.U8, T.SCHEMA]), 42: S.list(T.U8), 43: S.list(T.SYMBOL), 44: S.listN(2, T.U8), 45: S.listN(2, T.U32),
  46: S.struct([['year', T.U8], ['month', T.U8], ['day', T.U8]]),
  48: S.struct([['netId', T.U8], ['freqMhz', 33], ['format', T.U8], ['baud', T.U8], ['duty', T.U8]]),
  52: S.struct([['verMajor', T.U8], ['verMinor', T.U8]]),
  57: S.typedMap(T.U8, T.STRING), 60: S.typedMap(T.U8, 43),
  61: S.fix(1, 32, 3), 63: S.fix(1, 32, 4), 64: S.fix(0, 32, 4),
  66: S.tuple([T.REF, T.REF]), 67: S.typedMap(T.SYMBOL, 66), 68: S.tuple([T.U8, T.STRING]), 73: S.tuple([T.U8, T.STRING]),
  74: S.struct([['lTime', T.U64], ['utc', T.U64]]), 75: T.U8, 76: T.BLOB, 86: S.typedMap(75, T.ANY),
  94: S.typedMap(T.U8, T.U8), 96: S.list(99), 99: S.tuple([T.SCHEMA, T.U8]), 100: S.tuple([T.U8, T.U32]), 101: S.fix(0, 64, 3),
  102: S.struct([['netId', T.U8], ['freq', T.U32], ['loraSpreadingFactor', T.U8], ['loraBandwidth', T.U8], ['loraCodingRate', T.U8],
    ['radioTimeslots', T.U8], ['radioSlotMs', T.U16], ['radioMaxData', T.U8], ['samplingInterval', T.U16], ['radioGroundSlotMs', T.U16]]),
  103: S.list(100),
  104: S.struct([['payload', T.BLOB], ['unixEpochStamp', 101]]),
  105: S.struct([['freq', T.U32], ['loraSpreadingFactor', T.U8], ['loraBandwidth', T.U8], ['loraCodingRate', T.U8],
    ['radioTimeslots', T.U8], ['radioSlotMs', T.U16], ['radioMaxData', T.U8], ['samplingInterval', T.U16], ['radioGroundSlotMs', T.U16]]),
  106: S.struct([['samplingInterval', T.FLOAT], ['payload', 42]]),
  107: S.list(T.U32), 108: S.tuple([T.U16, 107]), 109: S.list(75), 112: S.tuple([T.U8, T.U16, T.STRING]),
  113: S.struct([['gnssId', T.U8], ['satId', T.U8], ['cno', T.U8], ['flags', T.U8]]), 114: S.list(113),
  // 3.11.8 additions (spec §3.3): Int32Fix1e6, Uint64AndNameMap (= sspDefaultSet), Uint32AndString, ListOfStrings
  115: S.fix(1, 32, 6), 116: S.tuple([T.U64, 31]), 117: S.tuple([T.U32, T.STRING]), 118: S.list(T.STRING),
};
export const REF = { NAMEMAP: 31, U8LIST: 42, SYMLIST: 43, OID: 75, OIDMAP: 86, SCHEMALIST: 96, NET_V5: 102, ENCKEY: 104, NET_V6: 105, GNSSSAT: 113, GNSSSATS: 114, DEFAULT_SET: 116 };

// ---- message table (§2.1): base code → field lists for the plain and the ticketed (0x80) form --
const F = (...pairs) => pairs;
export const MSG = {
  4: { name: 'cinfo', plain: F(['ver', T.U8], ['magicByte', T.U8], ['tk', T.U8], ['serial', T.U32], ['id', T.U8], ['parent', T.U8], ['prio', T.U8], ['componentType', T.U8], ['compatibility', T.U8], ['name', T.STRING]) },
  5: { name: 'newid', plain: F(['tk', T.U8], ['id', T.U8], ['prio', T.U8], ['name', T.STRING]) },
  31: { name: 'newidWithRev', plain: F(['tk', T.U8], ['id', T.U8], ['prio', T.U8], ['revision', T.U8], ['name', T.STRING]) },
  32: { name: 'newidAck', plain: F(['revision', T.U8]) },
  6: { name: 'reply', plain: F(['from', T.U8], ['tk', T.U8], ['b', T.ANY]) },
  7: { name: 'ack', plain: F(['from', T.U8], ['tk', T.U8], ['b', T.ANY]) },
  8: { name: 'nack', plain: F(['from', T.U8], ['tk', T.U8], ['code', T.U8]) },
  11: { name: 'rep', plain: F(['map', REF.OIDMAP]) },
  14: { name: 'call', plain: F(['sym', T.SYMBOL], ['arg', T.ANY]), ticketed: F(['from', T.U8], ['tk', T.U8], ['sym', T.SYMBOL], ['arg', T.ANY]) },
  15: { name: 'uget', plain: F(['var', REF.SYMLIST]), ticketed: F(['from', T.U8], ['tk', T.U8], ['var', REF.SYMLIST]) },
  16: { name: 'get', plain: F(['var', REF.SYMLIST]), ticketed: F(['from', T.U8], ['tk', T.U8], ['var', REF.SYMLIST]) },
  17: { name: 'set', plain: F(['map', REF.NAMEMAP]), ticketed: F(['from', T.U8], ['tk', T.U8], ['map', REF.NAMEMAP]) },
  18: { name: 'sub', plain: F(['from', T.U8], ['sym', REF.SYMLIST]), ticketed: F(['from', T.U8], ['tk', T.U8], ['sender', T.U8], ['sym', REF.SYMLIST]) },
  19: { name: 'unsub', plain: F(['from', T.U8], ['sym', REF.SYMLIST]), ticketed: F(['from', T.U8], ['tk', T.U8], ['sender', T.U8], ['sym', REF.SYMLIST]) },
  21: { name: 'getVarType', plain: F(['sym', REF.SYMLIST]), ticketed: F(['from', T.U8], ['tk', T.U8], ['sym', REF.SYMLIST]) },
  26: { name: 'getVarList', plain: F(), ticketed: F(['from', T.U8], ['tk', T.U8]) },
  30: { name: 'wentoffline', plain: F(['from', T.U8], ['ids', REF.U8LIST]) },
};
export const CODE = Object.fromEntries(Object.entries(MSG).map(([c, m]) => [m.name, Number(c)]));
export const REPLY_BIT = 0x80;
export const NACK_TEXT = { 0: 'OK', 1: 'unspecified failure', 2: 'out of memory', 3: 'busy', 4: 'not delivered', 5: 'unknown variable', 6: 'argument error', 7: 'data error', 8: 'blocked', 9: 'unknown definition', 10: 'external error', 11: 'logical error', 12: 'unknown object', 13: 'too big data', 14: 'feature not supported', 15: 'text parsing error', 16: 'timeout', 17: 'end of data', 18: 'out of resources', 127: 'yield', 128: 'OK pending' };

/** A value with its explicit wire type (regIx number or schema object); keeps round trips byte-exact. */
export class Typed { constructor(type, value) { this.type = type; this.value = value; } }
/** A symbol id inside an "Any" value (distinct from a plain integer on the wire). */
export class Sym { constructor(id) { this.id = id; } }
/** Recursively strip Typed/Sym wrappers → plain JS values (Map stays Map). */
export function plain(v) {
  if (v instanceof Typed) return plain(v.value);
  if (v instanceof Sym) return v.id;
  if (Array.isArray(v)) return v.map(plain);
  if (v instanceof Map) { const m = new Map(); for (const [k, x] of v) m.set(plain(k), plain(x)); return m; }
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) { const o = {}; for (const k of Object.keys(v)) o[k] = plain(v[k]); return o; }
  return v;
}

// ---- byte reader / writer ----------------------------------------------------------------------
class Reader {
  constructor(bytes) { this.b = bytes; this.p = 0; this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  need(n) { if (this.p + n > this.b.length) throw new Error(`E_SSP_SHORT: need ${n} byte(s) at offset ${this.p}, have ${this.b.length - this.p}`); }
  u8() { this.need(1); return this.b[this.p++]; }
  u16() { this.need(2); const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  i16() { this.need(2); const v = this.dv.getInt16(this.p, true); this.p += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f32() { this.need(4); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  u64() { this.need(8); const v = this.dv.getBigUint64(this.p, true); this.p += 8; return Number(v); }
  i64() { this.need(8); const v = this.dv.getBigInt64(this.p, true); this.p += 8; return Number(v); }
  bytes(n) { this.need(n); const v = this.b.slice(this.p, this.p + n); this.p += n; return v; }
  varuint() { let v = 0, shift = 0; for (;;) { const x = this.u8(); v += (x & 0x7f) * 2 ** shift; if (!(x & 0x80)) return v; shift += 7; if (shift > 35) throw new Error('E_SSP_VARUINT: too long'); } }
  get left() { return this.b.length - this.p; }
}
class Writer {
  constructor() { this.a = []; }
  u8(v) { if (v < 0 || v > 255 || !Number.isInteger(v)) throw new Error(`E_SSP_RANGE: ${v} is not a U8`); this.a.push(v); }
  n(v, bytes, signed, label) {
    if (!Number.isInteger(v)) throw new Error(`E_SSP_RANGE: ${v} is not an integer (${label})`);
    const dv = new DataView(new ArrayBuffer(8));
    if (bytes === 8) { signed ? dv.setBigInt64(0, BigInt(v), true) : dv.setBigUint64(0, BigInt(v), true); }
    else {
      const min = signed ? -(2 ** (bytes * 8 - 1)) : 0, max = signed ? 2 ** (bytes * 8 - 1) - 1 : 2 ** (bytes * 8) - 1;
      if (v < min || v > max) throw new Error(`E_SSP_RANGE: ${v} does not fit ${label}`);
      if (bytes === 2) signed ? dv.setInt16(0, v, true) : dv.setUint16(0, v, true); else signed ? dv.setInt32(0, v, true) : dv.setUint32(0, v, true);
    }
    for (let i = 0; i < bytes; i++) this.a.push(dv.getUint8(i));
  }
  f32(v) { const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, v, true); for (let i = 0; i < 4; i++) this.a.push(dv.getUint8(i)); }
  bytes(u) { for (const x of u) this.a.push(x); }
  varuint(v) { if (!Number.isInteger(v) || v < 0) throw new Error(`E_SSP_RANGE: bad symbol ${v}`); do { let x = v % 128; v = Math.floor(v / 128); if (v) x |= 0x80; this.a.push(x); } while (v); }
  sized(u) { if (u.length > 255) throw new Error('E_SSP_RANGE: sized item > 255 bytes'); this.u8(u.length); this.bytes(u); }
  get bytesOut() { return Uint8Array.from(this.a); }
}
export const varuintEncode = (v) => { const w = new Writer(); w.varuint(v); return w.bytesOut; };
export const varuintDecode = (bytes) => new Reader(bytes).varuint();
const ascii = (s) => Uint8Array.from(String(s), (c) => c.charCodeAt(0) & 0x7f);
const fromAscii = (u) => String.fromCharCode(...u);

// ---- schema (type 11) parsing / writing (§3.2 "schema:" columns) --------------------------------
function readSchemaAfterTag(tag, r) {
  switch (tag) {
    case T.TYPED_MAP: return S.typedMap(readSchema(r), readSchema(r));
    case T.STRUCT: { const n = r.u8(), fields = []; for (let i = 0; i < n; i++) { const name = r.varuint(); fields.push([name, readSchema(r)]); } return S.struct(fields); }
    case T.TUPLE: { const n = r.u8(), items = []; for (let i = 0; i < n; i++) items.push(readSchema(r)); return S.tuple(items); }
    case T.TYPED_LIST: return S.list(readSchema(r));
    case T.TYPED_LIST_N: { const n = r.u8(); return S.listN(n, readSchema(r)); }
    case T.FIXPOINT: return S.fix(r.u8(), r.u8(), r.u8());
    case T.SCALED: { const bits = r.u8(), signed = r.u8(); return S.scaled(bits, signed, r.f32(), r.f32()); }
    case T.CONSTANT: { const schema = readSchema(r); return { f: T.CONSTANT, schema, value: decodeImp(schema, r) }; }
    default: throw new Error(`E_SSP_SCHEMA: unsupported format ${tag}`);
  }
}
export function readSchema(r) { const tag = r.u8(); return isFormat(tag) ? readSchemaAfterTag(tag, r) : tag; }
export function writeSchema(s, w) {
  if (typeof s === 'number') { w.u8(s); return; }
  w.u8(s.f);
  switch (s.f) {
    case T.TYPED_MAP: writeSchema(s.k, w); writeSchema(s.v, w); break;
    case T.STRUCT: w.u8(s.fields.length); for (const [name, sc] of s.fields) { w.varuint(typeof name === 'number' ? name : 0); writeSchema(sc, w); } break;
    case T.TUPLE: w.u8(s.items.length); for (const it of s.items) writeSchema(it, w); break;
    case T.TYPED_LIST: writeSchema(s.of, w); break;
    case T.TYPED_LIST_N: w.u8(s.n); writeSchema(s.of, w); break;
    case T.FIXPOINT: w.u8(s.signed); w.u8(s.bits); w.u8(s.decimals); break;
    case T.SCALED: w.u8(s.bits); w.u8(s.signed); w.f32(s.scale); w.f32(s.offset); break;
    case T.CONSTANT: writeSchema(s.schema, w); encodeImp(s.schema, s.value, w); break;
    default: throw new Error(`E_SSP_SCHEMA: cannot write format ${s.f}`);
  }
}
/** Human-readable schema label for logs ("U8", "REF105", "Fixpoint(1,16,2)"). */
export function schemaName(s) {
  if (typeof s === 'number') return s < 31 ? (Object.keys(T).find((k) => T[k] === s) || String(s)) : `REF${s}`;
  if (s.f === T.FIXPOINT) return `Fixpoint(${s.signed},${s.bits},${s.decimals})`;
  return Object.keys(T).find((k) => T[k] === s.f) || `format${s.f}`;
}

// ---- implicit decoding -------------------------------------------------------------------------
function intOf(bits, signed, r) {
  if (bits === 8) return signed ? ((r.u8() << 24) >> 24) : r.u8();
  if (bits === 16) return signed ? r.i16() : r.u16();
  if (bits === 32) return signed ? r.i32() : r.u32();
  if (bits === 64) return signed ? r.i64() : r.u64();
  throw new Error(`E_SSP_SCHEMA: bad width ${bits}`);
}
function intTo(bits, signed, v, w) {
  if (bits === 8) { if (signed && (v < -128 || v > 127)) throw new Error(`E_SSP_RANGE: ${v} does not fit I8`); w.u8(signed ? v & 0xff : v); return; }
  w.n(v, bits / 8, !!signed, `${signed ? 'I' : 'U'}${bits}`);
}

export function decodeImp(schema, r) {
  if (typeof schema === 'number') {
    switch (schema) {
      case T.NULL: return null;
      case T.BOOL: { const v = r.u8(); return v === 255 ? null : v !== 0; }
      case T.U8: return r.u8();
      case T.U16: return r.u16();
      case T.I16: return r.i16();
      case T.I32: return r.i32();
      case T.U32: return r.u32();
      case T.FLOAT: return r.f32();
      case T.SYMBOL: return r.varuint();                 // schema-typed symbol → plain id (expBin → Sym, see decodeExp)
      case T.STRING: return fromAscii(r.bytes(r.u8()));
      case T.BLOB: return r.bytes(r.u8());
      case T.SCHEMA: return readSchema(r);
      case T.ANY: return decodeExp(r);
      // Generic Map keeps Sym keys as decoded (byte-exact re-encode); asNameMap() normalises them.
      case T.MAP: { const n = r.u8(), m = new Map(); for (let i = 0; i < n; i++) { const k = decodeExp(r); m.set(k, decodeExp(r)); } return m; }
      case T.LIST: { const n = r.u8(), a = []; for (let i = 0; i < n; i++) a.push(decodeExp(r)); return a; }
      case T.REF: return r.u8();
      case T.I64: return r.i64();
      case T.U64: return r.u64();
      default: {
        if (REGISTRY[schema]) return decodeImp(REGISTRY[schema], r);
        throw new Error(`E_SSP_SCHEMA: unknown registry index ${schema}`);
      }
    }
  }
  switch (schema.f) {
    case T.TYPED_MAP: { const n = r.u8(), m = new Map(); for (let i = 0; i < n; i++) { const k = decodeImp(schema.k, r); m.set(k instanceof Sym ? k.id : k, decodeImp(schema.v, r)); } return m; }
    case T.STRUCT: { const o = {}; for (const [name, sc] of schema.fields) o[name] = decodeImp(sc, r); return o; }
    case T.TUPLE: return schema.items.map((it) => decodeImp(it, r));
    case T.TYPED_LIST: { const n = r.u8(), a = []; for (let i = 0; i < n; i++) a.push(decodeImp(schema.of, r)); return a; }
    case T.TYPED_LIST_N: { const a = []; for (let i = 0; i < schema.n; i++) a.push(decodeImp(schema.of, r)); return a; }
    case T.FIXPOINT: { const i = intOf(schema.bits, schema.signed, r); return i / 10 ** schema.decimals; }
    case T.SCALED: { const i = intOf(schema.bits, schema.signed, r); return i * schema.scale + schema.offset; }
    case T.CONSTANT: return schema.value;
    case T.UNION: { const key = decodeImp(schema.keyType, r); const opt = schema.options[key]; if (!opt) throw new Error(`E_SSP_SCHEMA: union key ${key} unknown`); return { key, value: decodeImp(opt, r) }; }
    default: throw new Error(`E_SSP_SCHEMA: cannot decode format ${schema.f}`);
  }
}
/** Explicitly typed value: tag byte (regIx or inline format) + implicit value. */
export function decodeExp(r) {
  const tag = r.u8();
  if (isFormat(tag)) { const schema = readSchemaAfterTag(tag, r); return new Typed(schema, decodeImp(schema, r)); }
  const v = tag === T.SYMBOL ? new Sym(r.varuint()) : decodeImp(tag, r);
  // Wrap everything the default encoder would not pick by itself (§3.2 "mimic Windsond" rule).
  const defaultTag = typeof v === 'number' ? defaultIntTag(v) : null;
  if (tag === T.U8 || tag === T.U16 || tag === T.I16 || tag === T.U32 || tag === T.I32) return defaultTag === tag ? v : new Typed(tag, v);
  if (tag === T.FLOAT) return Number.isInteger(v) ? new Typed(tag, v) : v;
  if (tag === T.NULL || tag === T.BOOL || tag === T.STRING || tag === T.BLOB || tag === T.LIST || tag === T.SYMBOL) return v;
  return new Typed(tag, v);
}
function defaultIntTag(v) {
  if (!Number.isInteger(v)) return T.FLOAT;
  if (v >= 0 && v <= 255) return T.U8;
  if (v >= 0 && v <= 65535) return T.U16;
  if (v >= -32768 && v <= 32767) return T.I16;
  if (v >= 0 && v <= 0xffffffff) return T.U32;
  if (v >= -(2 ** 31) && v < 2 ** 31) return T.I32;
  return v < 0 ? T.I64 : T.U64;
}

// ---- implicit / explicit encoding ---------------------------------------------------------------
const unwrap = (v) => (v instanceof Typed ? v.value : v);
export function encodeImp(schema, value, w) {
  if (typeof schema === 'number') {
    const v = unwrap(value);
    switch (schema) {
      case T.NULL: return;
      case T.BOOL: w.u8(v === null || v === undefined ? 255 : v ? 1 : 0); return;
      case T.U8: w.u8(v); return;
      case T.U16: w.n(v, 2, false, 'U16'); return;
      case T.I16: w.n(v, 2, true, 'I16'); return;
      case T.I32: w.n(v, 4, true, 'I32'); return;
      case T.U32: w.n(v, 4, false, 'U32'); return;
      case T.FLOAT: w.f32(v); return;
      case T.SYMBOL: w.varuint(v instanceof Sym ? v.id : v); return;
      case T.STRING: w.sized(ascii(v ?? '')); return;
      case T.BLOB: w.sized(v instanceof Uint8Array ? v : Uint8Array.from(v)); return;
      case T.SCHEMA: writeSchema(v, w); return;
      case T.ANY: encodeExp(value, w); return;
      case T.MAP: { const e = entries(v); w.u8(e.length); for (const [k, x] of e) { encodeExp(k, w); encodeExp(x, w); } return; }
      case T.LIST: w.u8(v.length); for (const x of v) encodeExp(x, w); return;
      case T.REF: w.u8(v); return;
      case T.I64: w.n(v, 8, true, 'I64'); return;
      case T.U64: w.n(v, 8, false, 'U64'); return;
      default:
        if (REGISTRY[schema]) { encodeImp(REGISTRY[schema], value, w); return; }
        throw new Error(`E_SSP_SCHEMA: unknown registry index ${schema}`);
    }
  }
  const v = unwrap(value);
  switch (schema.f) {
    case T.TYPED_MAP: { const e = entries(v); w.u8(e.length); for (const [k, x] of e) { encodeImp(schema.k, k, w); encodeImp(schema.v, x, w); } return; }
    case T.STRUCT: for (const [name, sc] of schema.fields) { if (!(name in v)) throw new Error(`E_SSP_ARG: struct field '${name}' missing`); encodeImp(sc, v[name], w); } return;
    case T.TUPLE: schema.items.forEach((it, i) => encodeImp(it, v[i], w)); return;
    case T.TYPED_LIST: w.u8(v.length); for (const x of v) encodeImp(schema.of, x, w); return;
    case T.TYPED_LIST_N: if (v.length !== schema.n) throw new Error(`E_SSP_ARG: fixed list needs ${schema.n} items`); for (const x of v) encodeImp(schema.of, x, w); return;
    case T.FIXPOINT: intTo(schema.bits, schema.signed, Math.round(v * 10 ** schema.decimals), w); return;
    case T.SCALED: intTo(schema.bits, schema.signed, Math.round((v - schema.offset) / schema.scale), w); return;
    case T.CONSTANT: return;
    case T.UNION: encodeImp(schema.keyType, v.key, w); encodeImp(schema.options[v.key], v.value, w); return;
    default: throw new Error(`E_SSP_SCHEMA: cannot encode format ${schema.f}`);
  }
}
function entries(v) {
  if (v instanceof Map) return [...v.entries()];
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).map((k) => [/^\d+$/.test(k) ? Number(k) : k, v[k]]);
  throw new Error('E_SSP_ARG: map value expected');
}
/** Explicit encoding of an "Any" value: Typed → its type; else the Windsond default choice (§3.2). */
export function encodeExp(value, w) {
  if (value instanceof Typed) { writeSchema(value.type, w); encodeImp(value.type, value.value, w); return; }
  if (value === null || value === undefined) { w.u8(T.NULL); return; }
  if (value instanceof Sym) { w.u8(T.SYMBOL); w.varuint(value.id); return; }
  if (typeof value === 'boolean') { w.u8(T.BOOL); w.u8(value ? 1 : 0); return; }
  if (typeof value === 'number') { const tag = defaultIntTag(value); w.u8(tag); encodeImp(tag, value, w); return; }
  if (typeof value === 'string') { w.u8(T.STRING); w.sized(ascii(value)); return; }
  if (value instanceof Uint8Array) { w.u8(T.BLOB); w.sized(value); return; }
  if (Array.isArray(value)) { w.u8(T.LIST); w.u8(value.length); for (const x of value) encodeExp(x, w); return; }
  if (value instanceof Map || typeof value === 'object') { w.u8(T.MAP); encodeImp(T.MAP, value, w); return; }
  throw new Error(`E_SSP_ARG: cannot encode ${typeof value}`);
}

// ---- frames ---------------------------------------------------------------------------------------
export function hexToBytes(hex) {
  let h = String(hex).trim();
  if (/^0x/i.test(h)) h = h.slice(2);
  const m = /^([0-9a-fA-F]{2})*/.exec(h)[0];
  if (m.length !== h.length) throw new Error(`E_SSP_HEX: non-hex data after ${m.length / 2} byte(s)`);
  const out = new Uint8Array(m.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(m.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export const bytesToHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * @param {{to:number, code?:number, name?:string, ticketed?:boolean, body:object}} msg
 * @returns {string} "0x…" (without line terminators – serial.js adds "\n…\n", spec §1.1)
 */
export function encodeFrame(msg) {
  const base = msg.code !== undefined ? msg.code & 0x7f : CODE[msg.name];
  if (base === undefined || !MSG[base]) throw new Error(`E_SSP_UNKNOWN_MSG: ${msg.name ?? msg.code}`);
  const ticketed = msg.code !== undefined ? !!(msg.code & REPLY_BIT) : !!msg.ticketed;
  const fields = ticketed ? MSG[base].ticketed : MSG[base].plain;
  if (!fields) throw new Error(`E_SSP_UNKNOWN_MSG: ${MSG[base].name} has no ${ticketed ? 'ticketed' : 'plain'} form`);
  const w = new Writer();
  w.u8(msg.to); w.u8(base | (ticketed ? REPLY_BIT : 0));
  for (const [name, schema] of fields) { if (!(name in msg.body)) throw new Error(`E_SSP_ARG: ${MSG[base].name}.${name} missing`); encodeImp(schema, msg.body[name], w); }
  return bytesToHex(w.bytesOut);
}
/** @returns {{to:number, code:number, base:number, name:string, ticketed:boolean, body:object}} */
export function decodeFrame(hexOrBytes) {
  const bytes = hexOrBytes instanceof Uint8Array ? hexOrBytes : hexToBytes(hexOrBytes);
  const r = new Reader(bytes);
  const to = r.u8(), code = r.u8(), base = code & 0x7f, ticketed = !!(code & REPLY_BIT);
  const def = MSG[base];
  if (!def) throw new Error(`E_SSP_UNKNOWN_MSG: code ${code} (0x${code.toString(16)})`);
  const fields = ticketed ? def.ticketed : def.plain;
  if (!fields) throw new Error(`E_SSP_UNKNOWN_MSG: ${def.name} code ${code} has no ${ticketed ? 'ticketed' : 'plain'} form`);
  const body = {};
  for (const [name, schema] of fields) body[name] = decodeImp(schema, r);
  if (r.left) throw new Error(`E_SSP_TRAILING: ${r.left} unexpected byte(s) after ${def.name}`);
  return { to, code, base, name: def.name, ticketed, body };
}
/** Report / NameMap helper: accept REF31 NameMap and generic Map (spec §8 Q5) → Map<symId, plain value>. */
export function asNameMap(any) {
  const v = plain(any);
  if (v instanceof Map) return v;
  if (Array.isArray(v)) return new Map(v);
  if (v && typeof v === 'object') return new Map(Object.keys(v).map((k) => [Number(k), v[k]]));
  throw new Error('E_SSP_DATA: value is not a map');
}
