// node --test: pure Worker helpers – observer codes, requireRole semantics (ground/master/observer),
// the WhatsApp standard message and wa.me links. No D1 / Durable Object needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observerCode, normalizeCode, requireRole, CODE_ALPHABET, HttpError } from '../worker/src/auth.js';
import { buildNotifyMessage, waUrl, waDigits, icaoShort, fmtLocal, waConfigured, sendWhatsApp } from '../worker/src/whatsapp.js';

test('observer code: 8 chars, alphabet without 0/O/1/I', () => {
  assert.equal(CODE_ALPHABET.length, 32);
  for (const c of '0O1I') assert.ok(!CODE_ALPHABET.includes(c));
  for (let i = 0; i < 50; i++) assert.match(observerCode(), /^[2-9A-HJ-NP-Z]{8}$/);
  assert.equal(normalizeCode(' 7k2m-4qx9 '), '7K2M4QX9');
});

test('requireRole: ground = any ground user, master = flag, observer = code token', () => {
  const master = { user: 'bwicki', role: 'ground', master: true };
  const crew = { user: 'crew1', role: 'ground', master: false };
  const obs = { user: 'Peter (CC)', role: 'observer', master: false, observerId: 1 };
  assert.equal(requireRole(master, 'ground'), master);
  assert.equal(requireRole(crew, 'ground'), crew);
  assert.equal(requireRole(master, 'master'), master);
  assert.throws(() => requireRole(crew, 'master'), (e) => e instanceof HttpError && e.status === 403);
  assert.throws(() => requireRole(obs, 'ground'), (e) => e.status === 403);
  assert.throws(() => requireRole(obs, 'master'), (e) => e.status === 403);
  assert.equal(requireRole(obs, 'observer'), obs);
  assert.equal(requireRole(obs), obs);                       // any authenticated principal
  assert.throws(() => requireRole(null), (e) => e.status === 401);
});

test('standard WhatsApp message (DE) from the ascent meta', () => {
  const meta = { plannedLaunch: Date.UTC(2026, 9, 17, 12, 30), start: { name: 'Rümlang', lat: 47.4433, lon: 8.5617 }, cutAltAgl: 3000, frequencyHz: 433900000, sondeId: 12345 };
  const msg = buildNotifyMessage(meta, '7K2M4QX9');
  assert.equal(msg, [
    'Sondenaufstieg geplant (S2 Ground)',
    'Start: 17.10.2026 14:30 LT',                            // Europe/Zurich = UTC+2 in October
    'Startort: Rümlang · 4727N00834E',
    "Cutdown: 3'000 m AGL",
    'Frequenz: 433.900 MHz',
    'Sonde: 12345',
    'Folgen: https://s2stueve.wicki.aero → Follow sonde ascent · Dein Code: 7K2M4QX9',
  ].join('\n'));
  // unknown values are left out, the follow line is always there
  const short = buildNotifyMessage({ start: { name: 'Rümlang' } }, 'B8R4TZ6W');
  assert.equal(short, 'Sondenaufstieg geplant (S2 Ground)\nStartort: Rümlang\nFolgen: https://s2stueve.wicki.aero → Follow sonde ascent · Dein Code: B8R4TZ6W');
  assert.equal(buildNotifyMessage({ cutAltAgl: null }, 'X').includes('Cutdown'), false);
});

test('ICAO / local time helpers match the web app rules', () => {
  assert.equal(icaoShort(47.4433, 8.5617), '4727N00834E');
  assert.equal(icaoShort(47.9967, 8.5), '4800N00830E');       // minutes round up to the next degree
  assert.equal(icaoShort(null, 8), '');
  assert.equal(fmtLocal(Date.UTC(2026, 0, 5, 9, 5)), '05.01.2026 10:05 LT');   // winter: UTC+1
  assert.equal(fmtLocal(NaN), '');
});

test('wa.me link and number cleaning', () => {
  assert.equal(waDigits('+41 79 123 45 67'), '41791234567');
  assert.equal(waDigits(''), '');
  assert.equal(waDigits('123'), '');
  assert.equal(waUrl('+41791234567', 'Hallo Welt'), 'https://wa.me/41791234567?text=Hallo%20Welt');
  assert.equal(waConfigured({ waPhoneNumberId: '1', waToken: 't' }), true);
  assert.equal(waConfigured({ waPhoneNumberId: '', waToken: 't' }), false);
});

test('sendWhatsApp never throws without configuration', async () => {
  const r = await sendWhatsApp({}, { waPhoneNumberId: '', waToken: '' }, '+41791234567', 'x');
  assert.deepEqual(r, { ok: false, status: 0, error: 'E_WA_NOT_CONFIGURED' });
  const bad = await sendWhatsApp({}, { waPhoneNumberId: '1', waToken: 't' }, '12', 'x');
  assert.equal(bad.error, 'E_WA_BAD_NUMBER');
});
