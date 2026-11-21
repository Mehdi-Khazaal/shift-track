// Unit tests for the paid-holiday calendar (assets/js/holidays.js).
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const Holidays = require(path.resolve(__dirname, '../../assets/js/holidays.js'));

describe('the 2026 list matches the company sheet for residential staff', () => {
  test('exactly these nine dates and names', () => {
    assert.deepStrictEqual(Holidays.holidaysForYear(2026), [
      { date: '2026-01-01', name: "New Year's Day" },
      { date: '2026-01-19', name: 'Martin Luther King Jr. Day' },
      { date: '2026-04-05', name: 'Easter Sunday' },
      { date: '2026-05-25', name: 'Memorial Day' },
      { date: '2026-06-19', name: 'Juneteenth' },
      { date: '2026-07-04', name: 'Independence Day' },
      { date: '2026-09-07', name: 'Labor Day' },
      { date: '2026-11-26', name: 'Thanksgiving' },
      { date: '2026-12-25', name: 'Christmas Day' },
    ]);
  });

  test('office-only days are not holidays: Good Friday and the observed July 3rd', () => {
    assert.strictEqual(Holidays.holidayOn('2026-04-03'), null);
    assert.strictEqual(Holidays.holidayOn('2026-07-03'), null);
  });
});

describe('later years follow the same rules', () => {
  test('2027', () => {
    assert.deepStrictEqual(Holidays.holidaysForYear(2027).map(h => h.date), [
      '2027-01-01', '2027-01-18', '2027-03-28', '2027-05-31', '2027-06-19',
      '2027-07-04', '2027-09-06', '2027-11-25', '2027-12-25',
    ]);
  });

  test('2028, including fixed holidays that land on a weekend (actual date kept)', () => {
    assert.deepStrictEqual(Holidays.holidaysForYear(2028).map(h => h.date), [
      '2028-01-01', '2028-01-17', '2028-04-16', '2028-05-29', '2028-06-19',
      '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
    ]);
  });

  test('Easter Sunday for a run of years', () => {
    const known = { 2025: '2025-04-20', 2029: '2029-04-01', 2030: '2030-04-21', 2031: '2031-04-13', 2035: '2035-03-25', 2038: '2038-04-25' };
    for (const [y, d] of Object.entries(known)) {
      assert.strictEqual(Holidays.holidaysForYear(y).find(h => h.name === 'Easter Sunday').date, d, `Easter ${y}`);
    }
  });
});

describe('holidayOn', () => {
  test('finds a holiday by date and ignores ordinary days', () => {
    assert.strictEqual(Holidays.holidayOn('2026-09-07').name, 'Labor Day');
    assert.strictEqual(Holidays.holidayOn('2026-09-06'), null);
  });

  test('accepts timestamps and rejects nonsense', () => {
    assert.strictEqual(Holidays.holidayOn('2026-12-25T10:00:00').name, 'Christmas Day');
    assert.strictEqual(Holidays.holidayOn('not a date'), null);
    assert.strictEqual(Holidays.holidayOn(null), null);
  });
});
