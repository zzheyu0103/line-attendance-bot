'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { addDays, distanceMeters, shiftHours, toMillis } = require('../src/utils');

test('跨日班別工時計算', () => {
  assert.equal(shiftHours('22:00', '06:00'), 8);
  assert.equal(shiftHours('09:30', '18:00'), 8.5);
});

test('日期加減可跨月份與年份', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('台北時間字串能正確比較', () => {
  assert.equal(toMillis('2026-08-21 10:00:00') - toMillis('2026-08-21 09:00:00'), 3600000);
});

test('GPS 距離計算與相同座標', () => {
  assert.equal(distanceMeters(25, 121, 25, 121), 0);
  const distance = distanceMeters(25.033964, 121.564468, 25.034964, 121.564468);
  assert.ok(distance > 100 && distance < 120);
});
