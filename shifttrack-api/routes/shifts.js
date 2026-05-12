const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');
const { payWeekOf } = require('../utils/ppAnchor');

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

// Returns true if a new concrete shift overlaps the user's base schedule on that date
async function overlapsBaseSchedule(userId, date, start_time, end_time) {
  const [settingsRes, suppressedRes] = await Promise.all([
    db.query('SELECT pp_anchor FROM user_settings WHERE user_id=$1', [userId]),
    db.query('SELECT id FROM base_suppressed_dates WHERE user_id=$1 AND date=$2', [userId, date]),
  ]);
  if (suppressedRes.rows.length) return false; // base schedule suppressed for this date

  const anchor    = settingsRes.rows[0]?.pp_anchor?.slice(0, 10) || '2026-03-22';
  const dayOfWeek = new Date(date + 'T12:00:00').getDay();
  const weekNum   = payWeekOf(date, anchor);

  const baseOverlap = await db.query(
    `SELECT id FROM base_schedule
     WHERE user_id=$1 AND week=$2 AND day_of_week=$3
       AND start_time < $5::time AND end_time > $4::time`,
    [userId, weekNum, dayOfWeek, start_time, end_time]
  );
  return baseOverlap.rows.length > 0;
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

// GET /api/shifts - get shifts for logged-in user + suppressed base dates
// Optional ?from=YYYY-MM-DD limits shifts to that date onward (used by bootstrap for initial load).
// Omit ?from to get full history (used by the "load older" UI action).
router.get('/', auth, async (req, res) => {
  try {
    const from = req.query.from || null;
    const shiftParams = [req.userId];
    const shiftWhere  = from ? 'AND s.date >= $2' : '';
    if (from) shiftParams.push(from);

    const [shiftsRes, suppressedRes] = await Promise.all([
      db.query(
        `SELECT s.*, l.name AS location_name, l.color, l.rate,
                fl.name AS from_location_name, fl.color AS from_location_color
         FROM shifts s
         JOIN locations l ON s.location_id = l.id
         LEFT JOIN locations fl ON s.pulled_from_location_id = fl.id
         WHERE s.user_id = $1 ${shiftWhere}
         ORDER BY s.date DESC, s.start_time DESC`,
        shiftParams
      ),
      db.query('SELECT date FROM base_suppressed_dates WHERE user_id=$1', [req.userId])
    ]);
    const suppressed = suppressedRes.rows.map(r => String(r.date).slice(0, 10));
    res.json({ ok: true, shifts: shiftsRes.rows, suppressed_bases: suppressed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/shifts - log a new shift
router.post('/', auth, async (req, res) => {
  const { location_id, date, start_time, end_time, notes } = req.body;
  if (!location_id || !date || !start_time || !end_time)
    return res.status(400).json({ ok: false, error: 'location_id, date, start_time, end_time are required' });

  if (shiftDurationMins(start_time, end_time) > MAX_SHIFT_MINS)
    return res.status(400).json({ ok: false, error: 'A single shift cannot exceed 18 hours.' });

  try {
    const overlap = await db.query(
      `SELECT id FROM shifts
       WHERE user_id=$1 AND date=$2
         AND start_time < $4::time AND end_time > $3::time`,
      [req.userId, date, start_time, end_time]
    );
    if (overlap.rows.length)
      return res.status(409).json({ ok: false, error: 'This shift overlaps an existing one on the same day' });

    if (await overlapsBaseSchedule(req.userId, date, start_time, end_time))
      return res.status(409).json({ ok: false, error: 'This shift overlaps your base schedule on that day' });

    const chainErr = await checkConsecutiveHours(req.userId, date, start_time, end_time);
    if (chainErr)
      return res.status(409).json({ ok: false, error: chainErr });

    const result = await db.query(
      `INSERT INTO shifts (user_id, location_id, date, start_time, end_time, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.userId, location_id, date, start_time, end_time, notes || '']
    );
    res.status(201).json({ ok: true, shift: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PUT /api/shifts/:id - edit a shift
router.put('/:id', auth, async (req, res) => {
  const { location_id, date, start_time, end_time, notes } = req.body;

  if (shiftDurationMins(start_time, end_time) > MAX_SHIFT_MINS)
    return res.status(400).json({ ok: false, error: 'A single shift cannot exceed 18 hours.' });

  try {
    const check = await db.query('SELECT open_shift_id, is_pulled FROM shifts WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    if (!check.rows.length) return res.status(404).json({ ok: false, error: 'Shift not found' });
    if (check.rows[0].open_shift_id) return res.status(403).json({ ok: false, error: 'Awarded shifts cannot be modified' });
    if (check.rows[0].is_pulled) return res.status(403).json({ ok: false, error: 'Pulled shifts cannot be modified' });
    if (await isAcceptedSwapShift(req.userId, req.params.id))
      return res.status(403).json({ ok: false, error: 'Swapped shifts cannot be modified' });

    const overlap = await db.query(
      `SELECT id FROM shifts
       WHERE user_id=$1 AND date=$2
         AND start_time < $4::time AND end_time > $3::time
         AND id != $5`,
      [req.userId, date, start_time, end_time, req.params.id]
    );
    if (overlap.rows.length)
      return res.status(409).json({ ok: false, error: 'This shift overlaps an existing one on the same day' });

    if (await overlapsBaseSchedule(req.userId, date, start_time, end_time))
      return res.status(409).json({ ok: false, error: 'This shift overlaps your base schedule on that day' });

    const chainErr = await checkConsecutiveHours(req.userId, date, start_time, end_time, req.params.id);
    if (chainErr)
      return res.status(409).json({ ok: false, error: chainErr });

    const result = await db.query(
      `UPDATE shifts SET location_id=$1, date=$2, start_time=$3, end_time=$4, notes=$5
       WHERE id=$6 AND user_id=$7 RETURNING *`,
      [location_id, date, start_time, end_time, notes || '', req.params.id, req.userId]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ ok: false, error: 'Shift not found' });
    res.json({ ok: true, shift: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/shifts/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const check = await db.query('SELECT open_shift_id, is_pulled FROM shifts WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    if (!check.rows.length) return res.json({ ok: true });
    if (check.rows[0].open_shift_id) return res.status(403).json({ ok: false, error: 'Awarded shifts cannot be removed' });
    if (check.rows[0].is_pulled) return res.status(403).json({ ok: false, error: 'Pulled shifts cannot be removed' });
    if (await isAcceptedSwapShift(req.userId, req.params.id))
      return res.status(403).json({ ok: false, error: 'Swapped shifts cannot be removed' });
    await db.query('DELETE FROM shifts WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
