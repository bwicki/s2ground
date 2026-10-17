// node --test: line classification (spec §1.2) and bracket parsing / conversions (spec §5.10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLine, parseBracketLine, parseTxtData, parseAbout, rssiFromParams, extractBracket } from '../../src/protocol/lines.js';

test('classifyLine: ssp spellings, messages, responses, logs, junk', () => {
  assert.equal(classifyLine('0x03060201190109025332').kind, 'ssp');
  assert.equal(classifyLine('\0\0>x0306020100').hex, '0x0306020100');
  assert.equal(classifyLine('00x0306020100').hex, '0x0306020100');
  assert.equal(classifyLine('0xABCD').hex, '0xabcd');
  assert.equal(classifyLine('0x0306zz').kind, 'unknown');
  assert.equal(classifyLine('0x030').kind, 'unknown', 'odd digit count');
  assert.equal(classifyLine('> [#DAT:id=1,seq=2]').kind, 'message');
  assert.equal(classifyLine('[echo=0]').kind, 'response');
  assert.equal(classifyLine('[]').kind, 'response');
  assert.equal(classifyLine('[12:00:01][D][radio] slot sync').kind, 'log');
  assert.equal(classifyLine('garbage before [#PK:rssi=40,rec=0] and after').bracket, '[#PK:rssi=40,rec=0]');
  assert.equal(classifyLine('hello world').kind, 'unknown');
  assert.equal(extractBracket('no bracket'), null);
});

test('parseBracketLine: spec example (S1 demo) with typed conversions', () => {
  const m = parseBracketLine('[#DAT:q=73,afc=15310,seq=29,su=4.09,te=19.50,md=0,pa=98634,hu=62.89,tmp2=22.40]');
  assert.equal(m.isMessage, true); assert.equal(m.type, 'DAT');
  assert.equal(m.params.q, 0x73); assert.equal(m.params.afc, 15310); assert.equal(m.params.seq, 29);
  assert.equal(m.params.su, 4.09); assert.equal(m.params.te, 19.5); assert.equal(m.params.md, 0); assert.equal(m.params.pa, 98634);
  assert.equal(m.params.hu, 62.89); assert.equal(m.params.tmp2, 22.4); assert.equal(m.params.new, 1, 'absent new → 1');
  assert.equal(m.data, ''); assert.equal(m.id, null);
  assert.ok(Math.abs(rssiFromParams(m.params) - 0x73 / 256) < 1e-9);
});

test('parseBracketLine: RR4/S2 keys, te wrap, md A, rs/snr rssi, tei=64 removed, data part with colons', () => {
  const m = parseBracketLine('[#DAT:id=12345,sid=2,seq=101,md=A,lat=47.443312,lon=8.561700,alt=1832.4,pa=81234,te=655.10,hu=45.2,spd=5.10,ang=-10.00,rise=2.4,su=3.98,rs=-88,snr=7,rec=3,sats=8,tei=64.00,enc=1]');
  assert.equal(m.id, 12345); assert.equal(m.params.md, 'A'); assert.equal(m.params.te, -0.26);
  assert.equal(m.params.ang, 317.68); assert.equal(m.params.tei, null); assert.equal(m.params.lat, 47.443312);
  assert.equal(m.params.enc, 1); assert.equal(m.params.sats, 8);
  assert.ok(Math.abs(rssiFromParams(m.params) - (-88 + 7 + 140) / 90) < 1e-9);
  assert.equal(rssiFromParams({ rs: -200, snr: 0 }), 0); assert.equal(rssiFromParams({ rs: 0, snr: 0 }), 1);
  assert.equal(rssiFromParams({ q0: 0x10, q1: 0x40 }), 0x40 / 256); assert.equal(rssiFromParams({ r: 128 }), 0.5); assert.equal(rssiFromParams({}), null);
  const r = parseBracketLine('[#RES:q=64,part=1:relAP=48120:1600]');
  assert.equal(r.type, 'RES'); assert.equal(r.params.part, 1); assert.equal(r.data, 'relAP=48120:1600');
  const t = parseBracketLine('[#TIM:]'); assert.equal(t.type, 'TIM'); assert.deepEqual(t.params, {});
  const resp = parseBracketLine('[frequency=433900000]'); assert.equal(resp.isMessage, false); assert.equal(resp.text, 'frequency=433900000');
  assert.equal(parseBracketLine('nothing'), null);
});

test('MET history keys keep their typed conversions (te wrap on history, ang history unwrap)', () => {
  const m = parseBracketLine('[#MET:id=5,seq=3,md=2,pa=90000,te=5.5,te1=655.00,te2=4.0,hu=50,hu1=51,hu2=52,spd=3,spd1=2.5,spd2=2,ang=100,ang1=-5.00,ang2=90]');
  assert.equal(m.params.te1, -0.36); assert.equal(m.params.te2, 4); assert.equal(m.params.ang1, 322.68); assert.equal(m.params.hu2, 52); assert.equal(m.params.spd1, 2.5);
});

test('parseTxtData and parseAbout', () => {
  assert.deepEqual(parseTxtData('R(S57B411C0L1)'), { kind: 'R', map: { S: 57, B: 411, C: 0, L: 1 }, inner: 'S57B411C0L1' });
  assert.deepEqual(parseTxtData('C(A1234T56)').map, { A: 1234, T: 56 });
  assert.equal(parseTxtData('plain text'), null);
  const a = parseAbout('about="Sparv RR4 hw=4, fw=1.4.2, prot=6"');
  assert.deepEqual([a.product, a.hw, a.fw, a.prot], ['Sparv RR4', '4', '1.4.2', 6]);
  const b = parseAbout('about="Sparv RR4 hw=2,\nfw=1.0, prot=4"');
  assert.deepEqual([b.hw, b.fw, b.prot], ['2', '1.0', 4]);
  assert.equal(parseAbout('Windsond receiver v2').product, 'Windsond receiver v2');
});
