// node --test: raw_flight_history.csv byte-exact format (spec §7.2), .sounding lines, KML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSV_HEADER, csvRow, csvText, soundingStamp, soundingLine, soundingHeader, kmlText, utcStamp } from '../web/src/files.js';

const T = Date.UTC(2025, 9, 13, 7, 15, 2);
const full = { t: T, alt: 1234.7, pa: 87651, spd: 4.52, ang: 213.4, te: 3.21, hu: 54.2, tei: 21.5, lat: 47.123456, lon: 8.654321, rise: 4.8 };

test('header is exact', () => {
  assert.equal(CSV_HEADER, 'UTC time, Altitude (m MSL), Altitude (m AGL), Pressure (Pascal), Speed (m/s), Heading (degrees), Temperature (C), Relative humidity (%), Internal temperature (C), Latitude, Longitude, Rise speed (m/s)');
});

test('example row from the spec', () => {
  assert.equal(csvRow(full, 422), '2025-10-13 07:15:02, 1234, 812, 87651, 4.52, 213.40, 3.21, 54.20, 21.50, 47.123456, 8.654321, 4.8\n');
});

test('missing values use the exact placeholders', () => {
  const r = csvRow({ t: T, alt: 500, pa: 95000, te: 10, hu: null, spd: null, ang: null, tei: null, lat: null, lon: null, rise: null }, null);
  assert.equal(r, '2025-10-13 07:15:02, 500,  , 95000,  ,  , 10.00,  ,  ,  ,  , \n'.replace(', 500,  , ', ', 500,  , '));
  // AGL unknown → " , "; spd/ang missing → " , "; tei missing → " , "; no position → " ,  , "; rise missing → empty
  assert.equal(r, '2025-10-13 07:15:02, 500,  , 95000,  ,  , 10.00,  ,  ,  ,  , \n');
});

test('rise 0.0 and -0.0 written as 0; %i truncates toward zero', () => {
  assert.ok(csvRow({ ...full, rise: 0.04 }, 422).endsWith(', 0\n'));
  assert.ok(csvRow({ ...full, rise: -0.04 }, 422).endsWith(', 0\n'));
  assert.ok(csvRow({ ...full, alt: -0.7, pa: 101400 }, 0).includes(', 0, 0, 101400'));
});

test('rows without pressure/altitude/met values are skipped', () => {
  assert.equal(csvRow({ ...full, pa: null }, 422), null);
  assert.equal(csvRow({ ...full, alt: null }, 422), null);
  assert.equal(csvRow({ t: T, alt: 1, pa: 1000, spd: null, ang: null, te: null, hu: null }, 0), null);
});

test('csvText starts at the launch index', () => {
  const recs = [{ ...full, t: T }, { ...full, t: T + 1000 }, { ...full, t: T + 2000 }];
  const txt = csvText(recs, 422, 1);
  assert.equal(txt.split('\n').length - 1, 3);           // header + 2 rows
  assert.ok(txt.startsWith(CSV_HEADER + '\n2025-10-13 07:15:03'));
});

test('sounding timestamps and id removal', () => {
  assert.equal(soundingStamp(0), '00m00s000: ');
  assert.equal(soundingStamp(203), '00m00s203: ');
  assert.equal(soundingStamp(3723456), '1h02m03s456: ');
  assert.equal(soundingStamp(-1500), '-00m01s500: ');
  assert.equal(soundingLine('[#DAT:id=123,seq=5,md=2]', 203, 123), '00m00s203: [#DAT:seq=5,md=2]\n');
  assert.equal(soundingLine('[#DAT:seq=5,id=123]', 0, 123), '00m00s000: [#DAT:seq=5]\n');
  const hdr = soundingHeader({ startMs: T, sondeId: 123, net: { timeslots: 1, slotMs: 1000, sampleMs: 1000 }, receiverAbout: 'Sparv RR4 hw=4, fw=1.4.2, prot=6' });
  assert.ok(hdr.includes('# version=4\n'));
  assert.ok(hdr.includes('# net_settings=1:1000:1000\n'));
  assert.ok(hdr.includes('# node_id=123\n'));
  assert.ok(hdr.includes(`# offset=${(T / 1000).toFixed(3)}`));
});

test('KML contains launch, path, peak and now', () => {
  const recs = [full, { ...full, t: T + 60000, alt: 2000, lat: 47.2, lon: 8.7 }, { ...full, t: T + 120000, alt: 900, lat: 47.25, lon: 8.75 }];
  const k = kmlText(recs, { name: 'Test', groundAlt: 430 });
  assert.ok(k.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.1">'));
  assert.ok(k.includes('<name>Launch Test</name>'));
  assert.ok(k.includes('8.700000,47.200000,2000'));
  assert.ok(k.includes('Peak (AGL 1570 m)'));
  assert.ok(k.includes('Location now (AGL 470 m)'));
  assert.ok(k.includes('<when>2025-10-13T07:15:02Z</when>'));
});

test('utcStamp', () => { assert.equal(utcStamp(T), '2025-10-13 07:15:02'); });
