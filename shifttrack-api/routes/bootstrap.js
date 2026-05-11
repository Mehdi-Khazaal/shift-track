const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');
const { DEFAULT_ANCHOR } = require('../utils/ppAnchor');

// GET /api/bootstrap?from=YYYY-MM-DD
// Returns all startup data in one authenticated request.
// When ?from= is provided, shifts are filtered to that date onward (saves bandwidth).
// shifts_partial=true in the response tells the client that older history exists.
router.get('/', auth, async (req, res) => {
  const from = req.query.from || null;
  try {
    const shiftParams = [req.userId];
    const shiftWhere  = from ? 'AND s.date >= $2' : '';
    if (from) shiftParams.push(from);

    const olderShiftsQuery = from
      ? db.query(
          'SELECT EXISTS (SELECT 1 FROM shifts WHERE user_id=$1 AND date < $2::date) AS has_older',
          [req.userId, from]
        )
      : Promise.resolve({ rows: [{ has_older: false }] });

    const [locsRes, shiftsRes, suppressedRes, baseRes, settingsRes, unavailRes, olderRes] = await Promise.all([
      db.query(`
        SELECT l.*,
               r.name           AS region_name,
               r.office_address AS region_office_address,
               u.name           AS specialist_name,
               u.email          AS specialist_email
        FROM locations l
        LEFT JOIN regions r ON r.id = l.region_id
        LEFT JOIN users   u ON u.id = l.specialist_id
        ORDER BY r.name ASC NULLS LAST, l.name ASC
      `),
      db.query(`
        SELECT s.*, l.name AS location_name, l.color, l.rate
        FROM shifts s JOIN locations l ON s.location_id = l.id
        WHERE s.user_id = $1 ${shiftWhere}
        ORDER BY s.date DESC, s.start_time DESC
      `, shiftParams),
      db.query('SELECT date FROM base_suppressed_dates WHERE user_id=$1', [req.userId]),
      db.query(`
        SELECT s.*, l.name AS location_name, l.color, l.rate
        FROM base_schedule s JOIN locations l ON s.location_id = l.id
        WHERE s.user_id = $1
        ORDER BY s.week, s.day_of_week, s.start_time
      `, [req.userId]),
      db.query('SELECT * FROM user_settings WHERE user_id=$1', [req.userId]),
      db.query(`
        SELECT * FROM user_unavailability
        WHERE user_id=$1
        ORDER BY start_date, start_time NULLS FIRST
      `, [req.userId]),
      olderShiftsQuery,
    ]);

    res.json({
      ok:               true,
      locations:        locsRes.rows,
      shifts:           shiftsRes.rows,
      suppressed_bases: suppressedRes.rows.map(r => String(r.date).slice(0, 10)),
      schedule:         baseRes.rows,
      settings:         settingsRes.rows[0] || { ot_threshold: 40, pp_anchor: DEFAULT_ANCHOR },
      unavailability:   unavailRes.rows,
      shifts_partial:   !!olderRes.rows[0]?.has_older,
    });
  } catch (err) {
    console.error('[bootstrap]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
