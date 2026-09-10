// Shared shift validation rules.
//
// Extracted verbatim from routes/shifts.js so the employee-scoped routes there
// and the admin-scoped routes in routes/admin.js enforce one identical rulebook.
// An admin assigning a shift must not be able to create something the employee
// app would have rejected.
const db = require('../db/index');
const { payWeekOf } = require('./ppAnchor');

const MAX_SHIFT_MINS = 18 * 60;
const GAP_LIMIT_MINS = 60;

function timeToMins(t) {
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

function shiftDurationMins(start, end) {
  let s = timeToMins(start), e = timeToMins(end);
  if (e <= s) e += 1440;
  return e - s;
}

function toAbsRange(dateStr, startStr, endStr) {
  const epoch = Date.UTC(2020, 0, 1);
  const [y, mo, d] = dateStr.slice(0, 10).split('-').map(Number);
  const dayBase = Math.round((Date.UTC(y, mo - 1, d) - epoch) / 60000);
  const s = timeToMins(startStr);
  let e = timeToMins(endStr);
  if (e <= s) e += 1440;
  return { startMins: dayBase + s, endMins: dayBase + e };
}

// Returns an error string if adding this shift would create a consecutive block >18h
// (shifts within 60 min of each other count as the same block).
// Checks both logged shifts and base schedule shifts.
async function checkConsecutiveHours(userId, date, start, end, excludeId = null) {
  const params = [userId, date];
  const excludeClause = excludeId ? `AND id != $${params.push(excludeId)}` : '';

  const [{ rows: loggedRows }, { rows: baseRows }, { rows: settingsRows }] = await Promise.all([
    db.query(
      `SELECT date, start_time, end_time FROM shifts
       WHERE user_id=$1
         AND date BETWEEN $2::date - interval '2 days' AND $2::date + interval '2 days'
         ${excludeClause}`,
      params
    ),
    db.query('SELECT week, day_of_week, start_time, end_time FROM base_schedule WHERE user_id=$1', [userId]),
    db.query('SELECT pp_anchor FROM user_settings WHERE user_id=$1', [userId]),
  ]);

  const anchor = settingsRows[0]?.pp_anchor?.slice(0, 10) || '2026-03-22';
  const anchorMs = Date.UTC(...anchor.split('-').map((v,i)=>i===1?Number(v)-1:Number(v)));

  // Resolve base schedule entries to actual dates within ±2 days
  const baseRanges = [];
  for (let offset = -2; offset <= 2; offset++) {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + offset);
    const dateStr = d.toISOString().slice(0, 10);
    const diff = Math.round((d.getTime() - anchorMs) / 86400000);
    const week = ((diff % 14) + 14) % 14 < 7 ? 1 : 2;
    const dow  = d.getUTCDay();
    for (const b of baseRows) {
      if (b.week === week && b.day_of_week === dow)
        baseRanges.push(toAbsRange(dateStr, b.start_time, b.end_time));
    }
  }

  const newRange = toAbsRange(date, start, end);
  const allRanges = [
    ...loggedRows.map(r => toAbsRange(r.date.slice(0, 10), r.start_time, r.end_time)),
    ...baseRanges,
    newRange
  ];

  const visited = new Set([newRange]);
  const queue = [newRange];
  let minStart = newRange.startMins, maxEnd = newRange.endMins;

  while (queue.length) {
    const curr = queue.shift();
    for (const other of allRanges) {
      if (visited.has(other)) continue;
      const g1 = other.startMins - curr.endMins;
      const g2 = curr.startMins - other.endMins;
      if ((g1 >= 0 && g1 < GAP_LIMIT_MINS) || (g2 >= 0 && g2 < GAP_LIMIT_MINS)) {
        visited.add(other);
        queue.push(other);
        minStart = Math.min(minStart, other.startMins);
        maxEnd   = Math.max(maxEnd,   other.endMins);
      }
    }
  }

  const span = maxEnd - minStart;
  if (span > MAX_SHIFT_MINS) {
    const h = Math.floor(span / 60), m = span % 60;
    const label = m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `These shifts total ${label} consecutive (max 18h; shifts within 1h of each other count as one block).`;
  }
  return null;
}

// ── Overlap detection ────────────────────────────────────────────────────
//
// Shifts are stored as (date, start_time, end_time) with no end date, so an
// overnight shift like 22:00-08:00 has end_time <= start_time and really
// occupies part of the FOLLOWING day.
//
// The old checks compared clock times on a single date:
//     start_time < $newEnd AND end_time > $newStart AND date = $date
// which silently missed two whole classes of conflict:
//   1. Overnight vs overnight. Existing 22:00-08:00, new 23:00-05:00 =>
//      "22:00 < 05:00" is false, so no conflict was reported.
//   2. Spill across midnight. A Monday 22:00-08:00 shift occupies Tuesday
//      00:00-08:00, but a new Tuesday 02:00 shift only ever compared against
//      rows dated Tuesday.
//
// Everything below therefore works in ABSOLUTE timestamps and scans the day
// before and after as well as the day itself.

// Resolve (date, start, end) to a concrete [start, end) timestamp pair,
// rolling the end into the next day when the shift crosses midnight.
function absRange(dateStr, start, end) {
  const d = dateStr.slice(0, 10);
  const s = start.slice(0, 5);
  const e = end.slice(0, 5);
  const endDay = timeToMins(e) <= timeToMins(s) ? addDays(d, 1) : d;
  return { start: `${d} ${s}:00`, end: `${endDay} ${e}:00` };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// True if the proposed shift collides with one the user has already logged.
// excludeId lets an edit ignore the row being edited.
async function overlapsExistingShift(userId, date, start_time, end_time, excludeId = null) {
  const range  = absRange(date, start_time, end_time);
  const params = [userId, date, range.start, range.end];
  const exclude = excludeId ? `AND id != $${params.push(excludeId)}` : '';

  const res = await db.query(
    `SELECT id FROM shifts
     WHERE user_id = $1
       AND date BETWEEN $2::date - 1 AND $2::date + 1
       ${exclude}
       AND (date + start_time) < $4::timestamp
       AND (date + end_time
            + CASE WHEN end_time <= start_time THEN interval '1 day'
                   ELSE interval '0 day' END) > $3::timestamp`,
    params
  );
  return res.rows.length > 0;
}

// True if the proposed shift collides with the user's recurring base schedule.
// Checks the day before and after too, so an overnight base entry that spills
// past midnight is still caught. Dates the admin has cancelled are skipped.
async function overlapsBaseSchedule(userId, date, start_time, end_time) {
  const candidates = [addDays(date, -1), date, addDays(date, 1)];

  const [settingsRes, suppressedRes, baseRes] = await Promise.all([
    db.query('SELECT pp_anchor FROM user_settings WHERE user_id=$1', [userId]),
    db.query('SELECT date FROM base_suppressed_dates WHERE user_id=$1 AND date = ANY($2::date[])',
      [userId, candidates]),
    db.query('SELECT week, day_of_week, start_time, end_time FROM base_schedule WHERE user_id=$1',
      [userId]),
  ]);
  if (!baseRes.rows.length) return false;

  const anchor     = settingsRes.rows[0]?.pp_anchor?.slice(0, 10) || '2026-03-22';
  const suppressed = new Set(suppressedRes.rows.map(r => String(r.date).slice(0, 10)));
  const target     = absRange(date, start_time, end_time);

  for (const day of candidates) {
    if (suppressed.has(day)) continue; // this occurrence was cancelled
    const week = payWeekOf(day, anchor);
    const dow  = new Date(day + 'T12:00:00').getDay();

    for (const b of baseRes.rows) {
      if (b.week !== week || b.day_of_week !== dow) continue;
      const r = absRange(day, b.start_time, b.end_time);
      if (r.start < target.end && r.end > target.start) return true;
    }
  }
  return false;
}

async function isAcceptedSwapShift(userId, shiftId) {
  const result = await db.query(
    `SELECT id FROM shift_swaps
     WHERE status='accepted'
       AND (
         (initiator_id=$1 AND swapped_initiator_shift_id=$2)
         OR
         (target_id=$1 AND swapped_target_shift_id=$2)
       )
     LIMIT 1`,
    [userId, shiftId]
  );
  return result.rows.length > 0;
}

module.exports = {
  MAX_SHIFT_MINS,
  GAP_LIMIT_MINS,
  timeToMins,
  shiftDurationMins,
  toAbsRange,
  checkConsecutiveHours,
  overlapsExistingShift,
  overlapsBaseSchedule,
  absRange,
  addDays,
  isAcceptedSwapShift,
};
