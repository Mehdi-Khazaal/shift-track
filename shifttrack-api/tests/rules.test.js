'use strict';

// Pure unit tests for the shared shift rules — no server, no database.
//
// Note on scope: overtime and pay TOTALS are computed client-side
// (computeWeekPay in assets/js/*.js), so they are not reachable from here.
// What lives server-side, and is tested below, is the duration/rotation maths
// that everything else is built on.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { shiftDurationMins, timeToMins, MAX_SHIFT_MINS } = require('../utils/shiftRules');
const { payWeekOf, DEFAULT_ANCHOR } = require('../utils/ppAnchor');

describe('shift duration', () => {
  test('a normal day shift', () => {
    assert.equal(shiftDurationMins('08:00', '16:00'), 480);
  });

  test('an overnight shift wraps past midnight instead of going negative', () => {
    // The bug this guards: 22:00 -> 08:00 naively reads as -840 minutes.
    assert.equal(shiftDurationMins('22:00', '08:00'), 600);
  });

  test('a shift ending exactly at midnight', () => {
    assert.equal(shiftDurationMins('16:00', '00:00'), 480);
  });

  test('seconds in a TIME value are ignored', () => {
    assert.equal(shiftDurationMins('08:00:00', '16:00:00'), 480);
  });

  test('18 hours is the documented ceiling', () => {
    assert.equal(MAX_SHIFT_MINS, 1080);
    assert.ok(shiftDurationMins('06:00', '23:59') < MAX_SHIFT_MINS);
    assert.ok(shiftDurationMins('04:00', '23:30') > MAX_SHIFT_MINS);
  });

  test('timeToMins', () => {
    assert.equal(timeToMins('00:00'), 0);
    assert.equal(timeToMins('12:30'), 750);
    assert.equal(timeToMins('23:59'), 1439);
  });
});

describe('pay-period week rotation', () => {
  const A = DEFAULT_ANCHOR; // 2026-03-22, a Sunday

  test('the anchor itself starts week 1', () => {
    assert.equal(payWeekOf('2026-03-22', A), 1);
  });

  test('days 0-6 are week 1, days 7-13 are week 2', () => {
    assert.equal(payWeekOf('2026-03-28', A), 1); // day 6
    assert.equal(payWeekOf('2026-03-29', A), 2); // day 7
    assert.equal(payWeekOf('2026-04-04', A), 2); // day 13
  });

  test('the rotation restarts on day 14', () => {
    assert.equal(payWeekOf('2026-04-05', A), 1);
  });

  test('dates before the anchor stay in the rotation', () => {
    // Negative modulo must not leak through as a negative index.
    assert.equal(payWeekOf('2026-03-21', A), 2);
    assert.equal(payWeekOf('2026-03-15', A), 2);
    assert.equal(payWeekOf('2026-03-14', A), 1);
  });

  test('always returns 1 or 2, a year out in both directions', () => {
    for (let i = -365; i <= 365; i++) {
      const d = new Date(A + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      const w = payWeekOf(d.toISOString().slice(0, 10), A);
      assert.ok(w === 1 || w === 2, `day ${i} produced ${w}`);
    }
  });
});
