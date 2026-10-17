// node --test: number/coordinate formatting helpers and ISA conversions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtInt, fmtNum, icaoShort, icaoSeconds, parseIcao, isaAltitude, isaPressure, altFromPressure, distanceM, bearingDeg, destPoint, windFromCourse, fmtBearing, googleMapsNavUrl, dewPoint } from '../src/util/format.js';

test('thousands separator (de-CH apostrophe)', () => {
  assert.equal(fmtInt(1910), "1'910"); assert.equal(fmtInt(123), '123'); assert.equal(fmtInt(1234567), "1'234'567");
  assert.equal(fmtInt(-1500), "−1'500"); assert.equal(fmtInt(null), '–'); assert.equal(fmtInt(1909.6), "1'910");
  assert.equal(fmtNum(-1.234, 1), '−1.2'); assert.equal(fmtNum(-0.04, 1), '0.0');
});

test('ICAO coordinates', () => {
  assert.equal(icaoShort(47.4433, 8.5617), '4727N00834E');
  assert.equal(icaoSeconds(47.4433, 8.5617), '472636N0083342E');
  assert.equal(icaoShort(-33.86, -151.2), '3352S15112W');
  assert.equal(icaoShort(47.9999, 8.9999), '4800N00900E');     // minute rounding carries into degrees
  const p = parseIcao('472636N0083342E');
  assert.ok(Math.abs(p.lat - 47.4433) < 0.0002 && Math.abs(p.lon - 8.5617) < 0.0002);
  assert.equal(parseIcao('nonsense'), null);
});

test('ISA conversions', () => {
  assert.ok(Math.abs(isaAltitude(101325)) < 0.01);
  assert.ok(Math.abs(isaAltitude(isaPressure(3000)) - 3000) < 0.5);
  // ground 432 m at 962.4 hPa → the same pressure maps back to the ground altitude
  assert.ok(Math.abs(altFromPressure(96240, 96240, 432) - 432) < 0.001);
  assert.ok(altFromPressure(80000, 96240, 432) > 1800);
  assert.ok(Math.abs(dewPoint(20, 50) - 9.3) < 0.2);
});

test('geodesy', () => {
  assert.ok(Math.abs(distanceM(47.0, 8.0, 48.0, 8.0) - 111195) < 200);
  assert.ok(Math.abs(bearingDeg(47.0, 8.0, 47.0, 9.0) - 89.6) < 1);
  const d = destPoint(47.4433, 8.5617, 58, 6900);
  assert.ok(Math.abs(distanceM(47.4433, 8.5617, d.lat, d.lon) - 6900) < 1);
  assert.equal(windFromCourse(58), 238); assert.equal(windFromCourse(300), 120);
  assert.equal(fmtBearing(58), '058°'); assert.equal(fmtBearing(360), '000°');
  assert.equal(googleMapsNavUrl(47.4711, 8.6189), 'https://www.google.com/maps/dir/?api=1&destination=47.471100,8.618900&travelmode=driving');
});
