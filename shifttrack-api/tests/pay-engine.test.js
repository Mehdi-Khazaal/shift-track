// Unit tests for the shared pay/OT engine (assets/js/pay-engine.js).
//
// Pure computation, no database — this suite requires the browser file directly
// via the module.exports shim at the bottom of it. It is the only coverage the
// frontend pay math has, so the cases here are the ones that were actually
// wrong before the engine existed.
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const PayEngine = require(path.resolve(__dirname, '../../assets/js/pay-engine.js'));

// Two houses at different rates, so a cross-house chain can be told apart.
const HOUSE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const HOUSE_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const RATES = { [HOUSE_A]: 20, [HOUSE_B]: 30 };
const rateOf = s => RATES[s.locationId] || 0;

let seq = 0;
function shift(date, start, end, extra) {
  return Object.assign(
    { id: `s${++seq}`, locationId: HOUSE_A, date, start, end, isBase: false },
    extra || {}
  );
}

// 2026-09-05 is a Saturday; 2026-09-06 the Sunday that opens the next week.
const SAT = '2026-09-05';
const SUN = '2026-09-06';
const SAT_WEEK = PayEngine.weekSundayOf(SAT);   // week of Aug 30
const SUN_WEEK = PayEngine.weekSundayOf(SUN);   // week of Sep 6

function inWeek(prepared, weekKey) {
  return prepared.filter(s => s.payWeek === weekKey);
}

describe('week attribution for overnight chains', () => {
  test('an overnight shift is paid in the week it starts', () => {
    const prepared = PayEngine.prepare([shift(SAT, '22:00', '08:00')]);
    assert.strictEqual(prepared[0].payWeek, SAT_WEEK);
    assert.strictEqual(inWeek(prepared, SUN_WEEK).length, 0);
  });

  test('a back-to-back chain crossing midnight stays whole in the first week', () => {
    // Sat 22:00->08:00 then Sun 08:00->16:00: 18 hours of continuous work.
    const prepared = PayEngine.prepare([
      shift(SAT, '22:00', '08:00'),
      shift(SUN, '08:00', '16:00'),
    ]);

    const sat = PayEngine.computePay(inWeek(prepared, SAT_WEEK), { rateOf });
    const sun = PayEngine.computePay(inWeek(prepared, SUN_WEEK), { rateOf });

    assert.strictEqual(sat.totalHrs, 18, 'Saturday week holds the whole chain');
    assert.strictEqual(sun.totalHrs, 0, 'Sunday week must not count it again');
    assert.strictEqual(sat.rows.length, 2, 'both legs stay as separate rows');
  });

  test('the same hours are never counted twice across the two weeks', () => {
    const prepared = PayEngine.prepare([
      shift(SAT, '22:00', '08:00'),
      shift(SUN, '08:00', '16:00'),
    ]);
    const total = PayEngine.computePay(inWeek(prepared, SAT_WEEK), { rateOf }).totalHrs
                + PayEngine.computePay(inWeek(prepared, SUN_WEEK), { rateOf }).totalHrs;
    assert.strictEqual(total, 18, '18 hours worked, 18 hours paid');
  });

  test('a gap of even one minute breaks the chain', () => {
    const prepared = PayEngine.prepare([
      shift(SAT, '22:00', '08:00'),
      shift(SUN, '08:01', '16:00'),
    ]);
    assert.strictEqual(inWeek(prepared, SAT_WEEK).length, 1);
    assert.strictEqual(inWeek(prepared, SUN_WEEK).length, 1);
  });

  test('a chain links across different houses', () => {
    const prepared = PayEngine.prepare([
      shift(SAT, '22:00', '08:00', { locationId: HOUSE_A }),
      shift(SUN, '08:00', '16:00', { locationId: HOUSE_B }),
    ]);
    assert.strictEqual(inWeek(prepared, SAT_WEEK).length, 2);
    assert.strictEqual(inWeek(prepared, SUN_WEEK).length, 0);
  });

  test('each leg of a cross-house chain is paid at its own rate', () => {
    const prepared = PayEngine.prepare([
      shift(SAT, '22:00', '08:00', { locationId: HOUSE_A }),   // 10h @ 20
      shift(SUN, '08:00', '16:00', { locationId: HOUSE_B }),   //  8h @ 30
    ]);
    const { rows, totalPay } = PayEngine.computePay(inWeek(prepared, SAT_WEEK), { rateOf });
    assert.strictEqual(rows[0].rate, 20);
    assert.strictEqual(rows[1].rate, 30);
    assert.strictEqual(totalPay, 10 * 20 + 8 * 30);
  });
});

describe('overtime', () => {
  test('hours past the threshold pay time and a half', () => {
    // 5 x 9h = 45h in one week, threshold 40 -> 5h OT.
    const days = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
    const prepared = PayEngine.prepare(days.map(d => shift(d, '09:00', '18:00')));
    const { totalHrs, totalOt, totalPay } = PayEngine.computePay(prepared, { rateOf });

    assert.strictEqual(totalHrs, 45);
    assert.strictEqual(totalOt, 5);
    assert.strictEqual(totalPay, 40 * 20 + 5 * 20 * 1.5);
  });

  test('the threshold comes from settings, not a hardcoded 40', () => {
    const days = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03'];
    const prepared = PayEngine.prepare(days.map(d => shift(d, '09:00', '19:00'))); // 4 x 10h
    const { totalOt } = PayEngine.computePay(prepared, { rateOf, otThreshold: 35 });
    assert.strictEqual(totalOt, 5);
  });

  test('totals always equal the sum of the rows', () => {
    const prepared = PayEngine.prepare([
      shift('2026-08-31', '09:00', '21:00'),
      shift('2026-09-01', '09:00', '21:00'),
      shift('2026-09-02', '09:00', '21:00'),
      shift('2026-09-03', '09:00', '21:00'),
    ]);
    const r = PayEngine.computePay(prepared, { rateOf });
    assert.strictEqual(r.totalPay, r.rows.reduce((a, x) => a + x.pay, 0));
    assert.strictEqual(r.totalHrs, r.rows.reduce((a, x) => a + x.hrs, 0));
    assert.strictEqual(r.totalOt,  r.rows.reduce((a, x) => a + x.otHrs, 0));
  });
});

describe('call-offs', () => {
  test('approved call-off hours are unpaid', () => {
    const prepared = PayEngine.prepare([shift('2026-09-01', '09:00', '17:00')]); // 8h
    const r = PayEngine.computePay(prepared, {
      rateOf,
      callOffHoursByDate: { '2026-09-01': 8 },
    });
    assert.strictEqual(r.totalHrs, 0);
    assert.strictEqual(r.totalPay, 0);
  });

  test('a call-off is deducted once per day, not once per shift', () => {
    // Two shifts on one day, one 4h call-off: 12h worked, 8h payable.
    const prepared = PayEngine.prepare([
      shift('2026-09-01', '06:00', '12:00'),   // 6h
      shift('2026-09-01', '14:00', '20:00'),   // 6h
    ]);
    const r = PayEngine.computePay(prepared, {
      rateOf,
      callOffHoursByDate: { '2026-09-01': 4 },
    });
    assert.strictEqual(r.totalHrs, 8, 'deducting 4h from each shift would give 4');
    assert.strictEqual(r.totalPay, 8 * 20);
  });

  test('a call-off longer than the day cannot drive hours negative', () => {
    const prepared = PayEngine.prepare([shift('2026-09-01', '09:00', '13:00')]); // 4h
    const r = PayEngine.computePay(prepared, {
      rateOf,
      callOffHoursByDate: { '2026-09-01': 99 },
    });
    assert.strictEqual(r.totalHrs, 0);
    assert.strictEqual(r.totalPay, 0);
  });

  test('callOffMap only counts approved call-offs', () => {
    const map = PayEngine.callOffMap([
      { type_name: 'call_off', status: 'approved', date: '2026-09-01', hours_requested: '4' },
      { type_name: 'call_off', status: 'pending',  date: '2026-09-01', hours_requested: '8' },
      { type_name: 'pto',      status: 'approved', date: '2026-09-01', hours_requested: '8' },
    ]);
    assert.deepStrictEqual(map, { '2026-09-01': 4 });
  });
});

describe('rates and premiums', () => {
  test('block workers earn the premium on base shifts only', () => {
    const prepared = PayEngine.prepare([
      shift('2026-09-01', '09:00', '17:00', { isBase: true }),
      shift('2026-09-02', '09:00', '17:00', { isBase: false }),
    ]);
    const { rows } = PayEngine.computePay(prepared, { rateOf, isBlock: true });
    assert.strictEqual(rows[0].rate, 20.5, 'base shift carries the premium');
    assert.strictEqual(rows[1].rate, 20,   'logged shift does not');
  });

  test('a pull rate override replaces the location rate', () => {
    const prepared = PayEngine.prepare([
      shift('2026-09-01', '09:00', '17:00', { locationId: HOUSE_B, payRateOverride: 20 }),
    ]);
    const { rows } = PayEngine.computePay(prepared, { rateOf });
    assert.strictEqual(rows[0].rate, 20, 'override wins over House B\'s 30');
  });

  test('pull bonuses are added on top of hourly pay', () => {
    const prepared = PayEngine.prepare([
      shift('2026-09-01', '09:00', '17:00', { pullBonus: 50 }),
    ]);
    const { totalPay } = PayEngine.computePay(prepared, { rateOf });
    assert.strictEqual(totalPay, 8 * 20 + 50);
  });
});

describe('late-night normalisation', () => {
  test('a 23:57 start is calculated as midnight the next day', () => {
    const [s] = PayEngine.prepare([shift(SAT, '23:57', '08:00')]);
    assert.strictEqual(s.date, SUN);
    assert.strictEqual(s.start, '00:00');
    assert.strictEqual(s.payWeek, SUN_WEEK);
  });

  test('23:54 is left alone', () => {
    const [s] = PayEngine.prepare([shift(SAT, '23:54', '08:00')]);
    assert.strictEqual(s.date, SAT);
    assert.strictEqual(s.payWeek, SAT_WEEK);
  });
});

describe('time primitives', () => {
  test('shiftHours handles a normal day, an overnight, and midnight', () => {
    assert.strictEqual(PayEngine.shiftHours('09:00', '17:00'), 8);
    assert.strictEqual(PayEngine.shiftHours('22:00', '08:00'), 10);
    assert.strictEqual(PayEngine.shiftHours('16:00', '00:00'), 8);
  });

  test('seconds in a TIME value are ignored', () => {
    assert.strictEqual(PayEngine.shiftHours('09:00:00', '17:00:00'), 8);
  });

  test('weekSundayOf returns the opening Sunday', () => {
    assert.strictEqual(PayEngine.weekSundayOf(SUN), SUN);
    assert.strictEqual(PayEngine.weekSundayOf(SAT), '2026-08-30');
  });
});

// ── Holiday pay (decided 2026-11-21) ─────────────────────────────────────────
// Every hour worked on a holiday date pays 1.5x. Holiday and OT do not stack,
// holiday hours count toward the 40h threshold, a call-off removes a shift's
// earliest hours, and each chain leg is judged by its own date.
// HOUSE_A pays $20/h, HOUSE_B $30/h.
describe('holiday pay', () => {
  const one = (seg, opts) =>
    PayEngine.computePay(PayEngine.prepare([seg]), Object.assign({ rateOf }, opts)).rows[0];
  const week = segs => PayEngine.computePay(PayEngine.prepare(segs), { rateOf });

  test('Labor Day overnight: Sep 6 22:00 -> Sep 7 08:00 is 8 holiday hours and 2 normal', () => {
    const r = one(shift('2026-09-06', '22:00', '08:00'));
    assert.strictEqual(r.hrs, 10);
    assert.strictEqual(r.holidayHrs, 8);
    assert.deepStrictEqual(r.holidayNames, ['Labor Day']);
    assert.strictEqual(r.pay, 10 * 20 + 8 * 20 * 0.5);      // $280
  });

  test('a shift running off the end of the holiday: Sep 7 20:00 -> Sep 8 04:00 is 4 holiday hours', () => {
    const r = one(shift('2026-09-07', '20:00', '04:00'));
    assert.strictEqual(r.holidayHrs, 4);
    assert.strictEqual(r.pay, 8 * 20 + 4 * 20 * 0.5);
  });

  test('a whole shift on the holiday pays 1.5x throughout', () => {
    const r = one(shift('2026-11-26', '08:00', '16:00'));
    assert.strictEqual(r.holidayHrs, 8);
    assert.strictEqual(r.pay, 8 * 20 * 1.5);
  });

  test('ending exactly at the midnight a holiday starts earns none; starting at it earns all', () => {
    assert.strictEqual(one(shift('2026-09-06', '16:00', '00:00')).holidayHrs, 0);
    assert.strictEqual(one(shift('2026-09-07', '00:00', '08:00')).holidayHrs, 8);
  });

  test('New Year: Dec 31 22:00 -> Jan 1 06:00 is 6 holiday hours', () => {
    const r = one(shift('2026-12-31', '22:00', '06:00'));
    assert.strictEqual(r.holidayHrs, 6);
    assert.deepStrictEqual(r.holidayNames, ["New Year's Day"]);
  });

  test('a 23:57 punch counted from midnight lands wholly on the holiday', () => {
    assert.strictEqual(one(shift('2026-12-31', '23:57', '08:00')).holidayHrs, 8);
  });

  test('ordinary days earn nothing extra', () => {
    const r = one(shift('2026-09-08', '08:00', '16:00'));
    assert.strictEqual(r.holidayHrs, 0);
    assert.strictEqual(r.pay, 8 * 20);
  });

  test('when the 40th hour falls inside a holiday shift, the OT part is not paid twice', () => {
    // Thanksgiving week: 38h Sunday-Wednesday, then 8h on Thanksgiving.
    const { rows } = week([
      shift('2026-11-22', '06:00', '16:00'), shift('2026-11-23', '06:00', '16:00'),
      shift('2026-11-24', '06:00', '16:00'), shift('2026-11-25', '08:00', '16:00'),
      shift('2026-11-26', '08:00', '16:00'),
    ]);
    const thu = rows[rows.length - 1];
    assert.strictEqual(thu.regHrs, 2);
    assert.strictEqual(thu.otHrs, 6);
    assert.strictEqual(thu.holidayRegHrs, 2);
    assert.strictEqual(thu.holidayOtHrs, 6);
    assert.strictEqual(thu.pay, 8 * 20 * 1.5, 'every hour 1.5x once, never 2.25x');
  });

  test('a holiday shift that is all overtime gets nothing extra on top', () => {
    const thu = week([
      shift('2026-11-22', '06:00', '16:00'), shift('2026-11-23', '06:00', '16:00'),
      shift('2026-11-24', '06:00', '16:00'), shift('2026-11-25', '06:00', '16:00'),
      shift('2026-11-26', '08:00', '16:00'),
    ]).rows[4];
    assert.strictEqual(thu.otHrs, 8);
    assert.strictEqual(thu.holidayRegHrs, 0);
    assert.strictEqual(thu.pay, 8 * 20 * 1.5);
  });

  test('holiday hours count toward the 40', () => {
    // 32h, then 8 holiday hours (reaching 40), so Friday is all OT.
    const { rows, totalOt } = week([
      shift('2026-11-22', '08:00', '16:00'), shift('2026-11-23', '08:00', '16:00'),
      shift('2026-11-24', '08:00', '16:00'), shift('2026-11-25', '08:00', '16:00'),
      shift('2026-11-26', '08:00', '16:00'), shift('2026-11-27', '08:00', '16:00'),
    ]);
    assert.strictEqual(rows[4].otHrs, 0);
    assert.strictEqual(rows[5].otHrs, 8);
    assert.strictEqual(totalOt, 8);
  });

  test('the block premium is part of the rate holiday pay multiplies, like OT', () => {
    const r = one(shift('2026-11-26', '08:00', '16:00', { isBase: true }), { isBlock: true });
    assert.strictEqual(r.rate, 20.5);
    assert.strictEqual(r.pay, 8 * 20.5 * 1.5);
  });

  test('a pull bonus stays flat', () => {
    const r = one(shift('2026-11-26', '08:00', '16:00', { pullBonus: 25 }));
    assert.strictEqual(r.pay, 8 * 20 * 1.5 + 25);
  });

  test('a call-off removes the earliest hours: 4h off a 06:00-12:00 holiday shift leaves 2 holiday hours', () => {
    const r = one(shift('2026-09-07', '06:00', '12:00'), { callOffHoursByDate: { '2026-09-07': 4 } });
    assert.strictEqual(r.hrs, 2);
    assert.strictEqual(r.holidayHrs, 2);
    assert.strictEqual(r.pay, 2 * 20 * 1.5);
  });

  test('a call-off on the evening before takes the non-holiday hours first', () => {
    const r = one(shift('2026-09-06', '22:00', '08:00'), { callOffHoursByDate: { '2026-09-06': 2 } });
    assert.strictEqual(r.hrs, 8);
    assert.strictEqual(r.holidayHrs, 8);
    assert.strictEqual(r.pay, 8 * 20 * 1.5);
  });

  test("a chain into Easter Sunday is paid in Saturday's week, and its Sunday hours are holiday hours", () => {
    const night = shift('2026-04-04', '22:00', '08:00', { isBase: true });            // HOUSE_A $20
    const morning = shift('2026-04-05', '08:00', '16:00', { locationId: HOUSE_B });   // HOUSE_B $30
    const prepared = PayEngine.prepare([night, morning]);
    assert.ok(prepared.every(s => s.payWeek === '2026-03-29'), "both legs in Saturday's week");
    const { rows } = PayEngine.computePay(prepared, { rateOf });
    assert.strictEqual(rows[0].holidayHrs, 8);
    assert.strictEqual(rows[0].pay, 10 * 20 + 8 * 20 * 0.5);
    assert.strictEqual(rows[1].holidayHrs, 8);
    assert.strictEqual(rows[1].pay, 8 * 30 * 1.5, 'each leg keeps its own house rate');
  });

  test('totals are the sums of the rows', () => {
    const res = week([
      shift('2026-09-06', '22:00', '08:00'), shift('2026-09-07', '20:00', '04:00'),
      shift('2026-09-09', '08:00', '16:00'),
    ]);
    assert.strictEqual(res.totalHoliday, res.rows.reduce((a, r) => a + r.holidayHrs, 0));
    assert.strictEqual(res.totalHoliday, 12);
    assert.strictEqual(res.totalPay, res.rows.reduce((a, r) => a + r.pay, 0));
  });

  test('a fractional OT threshold keeps the holiday/OT split exact (no 0.1h rounding)', () => {
    // Threshold 40.25, 40h before Thanksgiving evening. Thu 20:00 -> Fri 04:00:
    // 0.25 regular + 7.75 OT; the first 4 hours are Thanksgiving. Every hour is
    // then worth 1.5x exactly once: 8 x $30 = $240 (rounding gave $239.50).
    const { rows } = PayEngine.computePay(PayEngine.prepare([
      shift('2026-11-22', '06:00', '16:00'), shift('2026-11-23', '06:00', '16:00'),
      shift('2026-11-24', '06:00', '16:00'), shift('2026-11-25', '06:00', '16:00'),
      shift('2026-11-26', '20:00', '04:00'),
    ]), { rateOf, otThreshold: 40.25 });
    const thu = rows[4];
    assert.strictEqual(thu.regHrs, 0.25);
    assert.strictEqual(thu.holidayRegHrs, 0.25);
    assert.strictEqual(thu.holidayOtHrs, 3.75);
    assert.strictEqual(thu.pay, 240);
  });

  test('the holiday calendar can be swapped out (tests, or a future policy change)', () => {
    const r = one(shift('2026-11-26', '08:00', '16:00'), { holidayOn: () => null });
    assert.strictEqual(r.holidayHrs, 0);
    assert.strictEqual(r.pay, 8 * 20);
  });
});
