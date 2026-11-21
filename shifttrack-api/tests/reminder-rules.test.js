// Unit tests for "one reminder per stretch" (utils/reminderRules.js).
//
// A shift that continues, at the same house, a shift ending at the exact
// minute it starts gets no reminder of its own. Pure logic, no database:
// reminderRules.js deliberately imports nothing that connects.
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { continuesStretch } = require('../utils/reminderRules');

const ANCHOR = '2026-03-22';          // a Sunday; week 1 starts here
const HOUSE_A = 'house-a', HOUSE_B = 'house-b';
const SAT = '2026-11-21', SUN = '2026-11-22';

// Under ANCHOR the pay period Nov 15-28 runs week 1 = Nov 15-21, week 2 =
// Nov 22-28 (Mar 22 + 244 days = Nov 21; 244 % 14 = 6, so still week 1).
const SAT_WEEK = 1;
const SAT_DOW = 6;

const logged = (date, start, end, location_id = HOUSE_A) =>
  ({ date, start_time: start, end_time: end, location_id });
const baseRow = (week, day_of_week, start, end, location_id = HOUSE_A) =>
  ({ week, day_of_week, start_time: start, end_time: end, location_id });

const ctx = extra => Object.assign(
  { logged: [], base: [], anchorStr: ANCHOR, suppressed: new Set(), leaveDates: new Set() }, extra);

describe('skips the reminder when the employee is already there', () => {
  test('a logged shift that starts as another logged shift at the same house ends', () => {
    const c = ctx({ logged: [logged(SUN, '08:00', '12:00')] });
    assert.strictEqual(continuesStretch({ date: SUN, start: '12:00', locationId: HOUSE_A }, c), true);
  });

  test('a morning shift continuing an overnight base shift from the day before', () => {
    const c = ctx({ base: [baseRow(SAT_WEEK, SAT_DOW, '22:00', '08:00')] });
    assert.strictEqual(continuesStretch({ date: SUN, start: '08:00', locationId: HOUSE_A }, c), true);
  });

  test('database time strings with seconds are understood', () => {
    const c = ctx({ logged: [logged(SUN, '08:00:00', '12:00:00')] });
    assert.strictEqual(continuesStretch({ date: SUN, start: '12:00:00', locationId: HOUSE_A }, c), true);
  });
});

describe('still sends the reminder', () => {
  test('the first shift of a stretch', () => {
    const c = ctx({ logged: [logged(SUN, '12:00', '16:00')] });
    assert.strictEqual(continuesStretch({ date: SUN, start: '08:00', locationId: HOUSE_A }, c), false);
  });

  test('when the shift before is at a different house (they have to travel)', () => {
    const c = ctx({ logged: [logged(SUN, '08:00', '12:00', HOUSE_B)] });
    assert.strictEqual(continuesStretch({ date: SUN, start: '12:00', locationId: HOUSE_A }, c), false);
  });

  test('when there is a gap, even one minute', () => {
    const c = ctx({ logged: [logged(SUN, '08:00', '11:59')] });
    assert.strictEqual(continuesStretch({ date: SUN, start: '12:00', locationId: HOUSE_A }, c), false);
  });

  test('when the base shift before was cancelled', () => {
    const c = ctx({ base: [baseRow(SAT_WEEK, SAT_DOW, '22:00', '08:00')], suppressed: new Set([SAT]) });
    assert.strictEqual(continuesStretch({ date: SUN, start: '08:00', locationId: HOUSE_A }, c), false);
  });

  test('when the shift before falls on a day with approved leave', () => {
    const c = ctx({ base: [baseRow(SAT_WEEK, SAT_DOW, '22:00', '08:00')], leaveDates: new Set([SAT]) });
    assert.strictEqual(continuesStretch({ date: SUN, start: '08:00', locationId: HOUSE_A }, c), false);
  });

  test('when the base entry belongs to the other week of the rotation', () => {
    const c = ctx({ base: [baseRow(3 - SAT_WEEK, SAT_DOW, '22:00', '08:00')] });
    assert.strictEqual(continuesStretch({ date: SUN, start: '08:00', locationId: HOUSE_A }, c), false);
  });

  test('when the location is unknown', () => {
    const c = ctx({ logged: [logged(SUN, '08:00', '12:00')] });
    assert.strictEqual(continuesStretch({ date: SUN, start: '12:00', locationId: null }, c), false);
  });
});
