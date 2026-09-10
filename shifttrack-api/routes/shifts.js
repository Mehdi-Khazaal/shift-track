const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');

const {
  MAX_SHIFT_MINS,
  shiftDurationMins,
  checkConsecutiveHours,
  overlapsExistingShift,
  overlapsBaseSchedule,
  isAcceptedSwapShift,
} = require('../utils/shiftRules');

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
    if (await overlapsExistingShift(req.userId, date, start_time, end_time))
      return res.status(409).json({ ok: false, error: 'This shift overlaps another shift you have already logged' });

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

    if (await overlapsExistingShift(req.userId, date, start_time, end_time, req.params.id))
      return res.status(409).json({ ok: false, error: 'This shift overlaps another shift you have already logged' });

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
