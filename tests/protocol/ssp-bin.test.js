// node --test: SSP-BIN round trips of every spec §2.4 example, varuint, fixpoint, schema parsing,
// NameMap/Map tolerance and error behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame, plain, varuintEncode, varuintDecode, encodeImp, decodeImp, Typed, Sym, S, T, REF, asNameMap, hexToBytes, bytesToHex, readSchema, writeSchema } from '../../src/protocol/ssp-bin.js';

// spec §2.4 (spaces removed)
const EXAMPLES = {
  cinfo: '0xff0403a6000100000000000000010670797468 6f6e', newid: '0xff0501033200', newidWithRev: '0xff1f0103320700', newidAck: '0xff2007',
  subComponents: '0x011203010d', repComponents: '0x030b01011f010d19020201 0202', ugetName: '0x028f03010105', replyName: '0x03060201190109025332',
  getVarType: '0x02950302 02cc08ba02', subS2: '0x02120304cc08ba02fa06b009', repS2: '0x030b01021f03cc080201ba02079a998140fa06065a810100',
  setRelAlt: '0x02910304 01d10803b80b', replySet: '0x0306020400', nack: '0x0308020405', callLedTest: '0x028e0305d30800',
  callGnssCmd: '0x028e0306d2040a0bffb562130002000102195b', callGnssGetAid: '0x018e0307d60400', ping: '0x018e0308180203',
  setNet: '0x01910309 01b10969400ecf19090001 06f4013ce803f401', unsub: '0x02130301cc08',
};
const clean = (h) => h.replace(/\s+/g, '');

test('every spec §2.4 example decodes and re-encodes byte-exact', () => {
  for (const [name, hex] of Object.entries(EXAMPLES)) {
    const d = decodeFrame(clean(hex));
    assert.equal(encodeFrame(d), clean(hex), name);
  }
});

test('decoded contents match the spec annotations', () => {
  const ci = decodeFrame(clean(EXAMPLES.cinfo));
  assert.deepEqual([ci.to, ci.name, ci.body.ver, ci.body.magicByte, ci.body.serial, ci.body.compatibility, ci.body.name], [255, 'cinfo', 3, 0xa6, 1, 1, 'python']);
  const rep = decodeFrame(clean(EXAMPLES.repComponents));
  assert.equal(rep.name, 'rep'); assert.deepEqual(plain(asNameMap(rep.body.map.get(1)).get(13)), [1, 2]);
  const rs2 = decodeFrame(clean(EXAMPLES.repS2));
  const v = asNameMap(rs2.body.map.get(2));
  assert.equal(v.get(1100), 1); assert.ok(Math.abs(v.get(314) - 4.05) < 1e-6); assert.equal(v.get(890), 98650);
  const net = plain(decodeFrame(clean(EXAMPLES.setNet)).body.map.get(1201));
  assert.deepEqual(net, { freq: 433000000, loraSpreadingFactor: 9, loraBandwidth: 0, loraCodingRate: 1, radioTimeslots: 6, radioSlotMs: 500, radioMaxData: 60, samplingInterval: 1000, radioGroundSlotMs: 500 });
  const gt = decodeFrame(clean(EXAMPLES.getVarType));
  assert.equal(gt.ticketed, true); assert.equal(gt.name, 'getVarType'); assert.deepEqual(gt.body.sym, [1100, 314]);
  const nk = decodeFrame(clean(EXAMPLES.nack)); assert.equal(nk.body.code, 5);
  const call = decodeFrame(clean(EXAMPLES.callGnssCmd)); assert.equal(call.body.sym, 594); assert.equal(call.body.arg.length, 11); assert.equal(call.body.arg[0], 0xff);
});

test('encodeFrame from plain JS objects produces the spec bytes', () => {
  assert.equal(encodeFrame({ to: 0xff, name: 'cinfo', body: { ver: 3, magicByte: 0xa6, tk: 0, serial: 1, id: 0, parent: 0, prio: 0, componentType: 0, compatibility: 1, name: 'python' } }), clean(EXAMPLES.cinfo));
  assert.equal(encodeFrame({ to: 1, name: 'sub', body: { from: 3, sym: [13] } }), clean(EXAMPLES.subComponents));
  assert.equal(encodeFrame({ to: 2, name: 'uget', ticketed: true, body: { from: 3, tk: 1, var: [5] } }), clean(EXAMPLES.ugetName));
  assert.equal(encodeFrame({ to: 2, code: 0x91, body: { from: 3, tk: 4, map: new Map([[1105, 3000]]) } }), clean(EXAMPLES.setRelAlt));
  assert.equal(encodeFrame({ to: 1, name: 'call', ticketed: true, body: { from: 3, tk: 8, sym: 24, arg: 3 } }), clean(EXAMPLES.ping));
  const net = { freq: 433000000, loraSpreadingFactor: 9, loraBandwidth: 0, loraCodingRate: 1, radioTimeslots: 6, radioSlotMs: 500, radioMaxData: 60, samplingInterval: 1000, radioGroundSlotMs: 500 };
  assert.equal(encodeFrame({ to: 1, name: 'set', ticketed: true, body: { from: 3, tk: 9, map: new Map([[1201, new Typed(REF.NET_V6, net)]]) } }), clean(EXAMPLES.setNet));
  assert.equal(encodeFrame({ to: 3, name: 'reply', body: { from: 2, tk: 1, b: ['S2'] } }), clean(EXAMPLES.replyName));
  assert.equal(encodeFrame({ to: 3, name: 'rep', body: { map: new Map([[2, new Typed(31, new Map([[1100, 1], [314, 4.05], [890, 98650]]))]]) } }), clean(EXAMPLES.repS2));
});

test('varuint and fixpoint', () => {
  assert.deepEqual([...varuintEncode(5)], [0x05]); assert.deepEqual([...varuintEncode(314)], [0xba, 0x02]); assert.deepEqual([...varuintEncode(1100)], [0xcc, 0x08]);
  assert.equal(varuintDecode(Uint8Array.from([0xcc, 0x08])), 1100); assert.equal(varuintDecode(Uint8Array.from([0x80, 0x80, 0x01])), 16384);
  const w = { a: [] }; // use encodeImp via a frame-less writer: wrap in a reply body to get bytes
  const hex = encodeFrame({ to: 1, name: 'reply', body: { from: 1, tk: 1, b: new Typed(36, -12.34) } });     // Int16Fix100
  assert.equal(hex, '0x010601012' + '4' + '2efb');                                                           // -1234 = 0xfb2e LE
  const d = decodeFrame(hex); assert.ok(d.body.b instanceof Typed); assert.equal(d.body.b.type, 36); assert.ok(Math.abs(d.body.b.value + 12.34) < 1e-9);
  const h2 = encodeFrame({ to: 1, name: 'reply', body: { from: 1, tk: 1, b: new Typed(40, 47.4433) } });     // Int32Fix1e6 GPS degrees
  assert.ok(Math.abs(decodeFrame(h2).body.b.value - 47.4433) < 1e-6);
  const h3 = encodeFrame({ to: 1, name: 'reply', body: { from: 1, tk: 1, b: new Typed(101, 1760339525.123) } }); // Uint64Fix1000
  assert.ok(Math.abs(decodeFrame(h3).body.b.value - 1760339525.123) < 1e-3);
  void w;
});

test('inline format schemas, Schema type and getVarType reply shapes', () => {
  // explicit TypedMap(Symbol, Any) written inline (13 08 15) instead of REF31 must decode the same values
  const inline = '0x030b0101' + '0d0815' + '010d19020201 0202'.replace(/\s/g, '');
  const d = decodeFrame(inline);
  assert.deepEqual(plain(asNameMap(d.body.map.get(1)).get(13)), [1, 2]);
  assert.equal(encodeFrame(d), inline, 'inline schema round trip');
  // generic Map (0x16) inside a report (spec §8 Q5) → same values via asNameMap
  const generic = encodeFrame({ to: 3, name: 'rep', body: { map: new Map([[2, new Typed(22, new Map([[new Sym(1100), 1], [new Sym(314), 4.05]]))]]) } });
  const g = decodeFrame(generic); const vals = asNameMap(g.body.map.get(2));
  assert.equal(vals.get(1100), 1); assert.ok(Math.abs(vals.get(314) - 4.05) < 1e-6); assert.equal(encodeFrame(g), generic);
  // getVarType reply as REF96 list of (Schema, U8)
  const gv = encodeFrame({ to: 3, name: 'reply', body: { from: 1, tk: 2, b: new Typed(96, [[REF.NET_V6, 1], [S.fix(1, 16, 2), 0], [T.U8, 0]]) } });
  const r = decodeFrame(gv).body.b;
  assert.equal(r.type, 96); assert.equal(r.value[0][0], 105); assert.deepEqual(r.value[1][0], { f: T.FIXPOINT, signed: 1, bits: 16, decimals: 2 }); assert.equal(r.value[2][1], 0);
  assert.equal(encodeFrame(decodeFrame(gv)), gv);
  // schema writer/reader symmetry for struct & tuple formats
  const w = { a: [], u8(v) { this.a.push(v); }, varuint(v) { this.a.push(v); }, f32() {} };
  writeSchema(S.struct([[4, T.U8], [5, T.STRING]]), w);
  assert.deepEqual(w.a, [14, 2, 4, 2, 5, 9]);
  const back = readSchema({ p: 0, b: Uint8Array.from(w.a), u8() { return this.b[this.p++]; }, varuint() { return this.b[this.p++]; } });
  assert.deepEqual(back, { f: T.STRUCT, fields: [[4, 2], [5, 9]] });
});

test('misc types: bool/null/string/blob/list/map/int64, structs REF104/113, hex helpers', () => {
  const b = { from: 1, tk: 1, b: [true, null, 'ab', Uint8Array.from([1, 2]), [1, 70000, -5, 2 ** 40, -(2 ** 40), 1.5], new Typed(22, new Map([[1, 'x']])), new Typed(REF.ENCKEY, { payload: new Uint8Array(16), unixEpochStamp: 1700000000.5 }), new Typed(REF.GNSSSATS, [{ gnssId: 0, satId: 5, cno: 40, flags: 7 }])] };
  const hex = encodeFrame({ to: 3, name: 'reply', body: b });
  const d = decodeFrame(hex);
  assert.equal(encodeFrame(d), hex);
  const p = plain(d.body.b);
  assert.deepEqual(p.slice(0, 3), [true, null, 'ab']); assert.deepEqual([...p[3]], [1, 2]); assert.deepEqual(p[4], [1, 70000, -5, 2 ** 40, -(2 ** 40), 1.5]);
  assert.equal(p[6].unixEpochStamp, 1700000000.5); assert.deepEqual(p[7], [{ gnssId: 0, satId: 5, cno: 40, flags: 7 }]);
  assert.equal(bytesToHex(hexToBytes('0xAB01')), '0xab01');
});

test('errors are descriptive and never silent', () => {
  assert.throws(() => decodeFrame('0x0399'), /E_SSP_UNKNOWN_MSG/);
  assert.throws(() => decodeFrame('0x030602'), /E_SSP_SHORT/);
  assert.throws(() => decodeFrame('0x030602040000ff'), /E_SSP_TRAILING/);
  assert.throws(() => decodeFrame('0x03zz'), /E_SSP_HEX/);
  assert.throws(() => encodeFrame({ to: 1, name: 'nope', body: {} }), /E_SSP_UNKNOWN_MSG/);
  assert.throws(() => encodeFrame({ to: 1, name: 'set', body: {} }), /E_SSP_ARG/);
  assert.throws(() => encodeFrame({ to: 1, name: 'reply', body: { from: 1, tk: 1, b: new Typed(T.U8, 300) } }), /E_SSP_RANGE/);
  assert.throws(() => decodeFrame('0x0306020499'), /E_SSP_SCHEMA|E_SSP_SHORT/, 'unknown registry index 0x99 in Any');
  // decodeImp/encodeImp exposed for structs
  const w = { a: [], u8(v) { this.a.push(v); }, n() {}, f32() {}, varuint() {}, sized() {}, bytes() {} };
  assert.throws(() => encodeImp(REF.NET_V6, { freq: 1 }, w), /E_SSP_ARG: struct field/);
  assert.equal(decodeImp(T.BOOL, { u8: () => 255 }), null, 'bool null representation');
});
