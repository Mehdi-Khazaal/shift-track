const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');
const { adminOnly } = require('../middleware/auth');
const { sendPushToUser } = require('../utils/push');

// POST /api/pulls/admin — admin creates a pull
router.post('/admin', auth, adminOnly, async (req, res) => {
  const { user_id, shift_id, from_location_id, to_location_id, pull_date, shift_start, shift_end, has_bonus } = req.body;
  if (!user_id || !to_location_id || !pull_date || !shift_start || !shift_end)
    return res.status(400).json({ ok: false, error: 'Missing required fields' });

  const bonusAmount = has_bonus ? 50.00 : 0.00;

  try {
    let finalShiftId = shift_id || null;
    let fromLocId    = from_location_id || null;

    if (shift_id) {
      // Logged shift — update its location in-place
      const shiftRes = await db.query('SELECT * FROM shifts WHERE id=$1 AND user_id=$2', [shift_id, user_id]);
      if (!shiftRes.rows.length) return res.status(404).json({ ok: false, error: 'Shift not found' });
      fromLocId = shiftRes.rows[0].location_id;
      await db.query(
        `UPDATE shifts SET location_id=$1, is_pulled=TRUE, pulled_from_location_id=$2, pull_bonus=$3 WHERE id=$4`,
        [to_location_id, fromLocId, bonusAmount, shift_id]
      );
    } else {
      // Base shift — suppress + create a logged override
      await db.query(
        `INSERT INTO base_suppressed_dates (user_id, date) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [user_id, pull_date]
      );
      const newShift = await db.query(
        `INSERT INTO shifts (user_id, location_id, date, start_time, end_time, is_pulled, pulled_from_location_id, pull_bonus)
         VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7) RETURNING id`,
        [user_id, to_location_id, pull_date, shift_start, shift_end, fromLocId, bonusAmount]
      );
      finalShiftId = newShift.rows[0].id;
    }

    // Audit record
    const pullRes = await db.query(
      `INSERT INTO shift_pulls
         (user_id, shift_id, from_location_id, to_location_id, pull_date, shift_start, shift_end, has_bonus, bonus_amount, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [user_id, finalShiftId, fromLocId, to_location_id, pull_date, shift_start, shift_end, has_bonus, bonusAmount, req.userId]
    );

    // Push notification to employee
    const toLoc = await db.query('SELECT name FROM locations WHERE id=$1', [to_location_id]);
    const toLocName = toLoc.rows[0]?.name || 'another location';
    const dateStr = new Date(pull_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const bonusMsg = has_bonus ? ' A $50 pull bonus has been added to your paycheck.' : '';
    await sendPushToUser(user_id, 'Shift Pull', `You've been pulled to ${toLocName} on ${dateStr}.${bonusMsg}`);

    res.json({ ok: true, pull: pullRes.rows[0] });
  } catch (err) {
    console.error('[pulls POST /admin]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/pulls/admin?user_id=xxx — all pulls for a user
router.get('/admin', auth, adminOnly, async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ ok: false, error: 'user_id required' });
  try {
    const result = await db.query(
      `SELECT sp.*,
              fl.name AS from_location_name, fl.color AS from_location_color,
              tl.name AS to_location_name,   tl.color AS to_location_color
       FROM shift_pulls sp
       LEFT JOIN locations fl ON sp.from_location_id = fl.id
       LEFT JOIN locations tl ON sp.to_location_id   = tl.id
       WHERE sp.user_id = $1
       ORDER BY sp.pull_date DESC, sp.created_at DESC`,
      [user_id]
    );
    res.json({ ok: true, pulls: result.rows });
  } catch (err) {
    console.error('[pulls GET /admin]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/pulls/admin/:id — undo a pull
router.delete('/admin/:id', auth, adminOnly, async (req, res) => {
  try {
    const pullRes = await db.query('SELECT * FROM shift_pulls WHERE id=$1', [req.params.id]);
    if (!pullRes.rows.length) return res.status(404).json({ ok: false, error: 'Pull not found' });
    const pull = pullRes.rows[0];
    if (pull.undone_at) return res.status(400).json({ ok: false, error: 'Already undone' });

    if (pull.shift_id) {
      const shiftRes = await db.query('SELECT * FROM shifts WHERE id=$1', [pull.shift_id]);
      if (shiftRes.rows.length) {
        if (pull.from_location_id) {
          // Restore original location
          await db.query(
            `UPDATE shifts SET location_id=$1, is_pulled=FALSE, pulled_from_location_id=NULL, pull_bonus=0 WHERE id=$2`,
            [pull.from_location_id, pull.shift_id]
          );
        } else {
          // Was a base shift override — delete the logged shift + remove suppression
          await db.query('DELETE FROM shifts WHERE id=$1', [pull.shift_id]);
          await db.query('DELETE FROM base_suppressed_dates WHERE user_id=$1 AND date=$2', [pull.user_id, pull.pull_date]);
        }
      }
    }

    await db.query('UPDATE shift_pulls SET undone_at=NOW(), undone_by=$1 WHERE id=$2', [req.userId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[pulls DELETE /admin/:id]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/pulls/mine — employee's own active pulls
router.get('/mine', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT sp.*,
              fl.name AS from_location_name,
              tl.name AS to_location_name
       FROM shift_pulls sp
       LEFT JOIN locations fl ON sp.from_location_id = fl.id
       LEFT JOIN locations tl ON sp.to_location_id   = tl.id
       WHERE sp.user_id = $1 AND sp.undone_at IS NULL
       ORDER BY sp.pull_date DESC`,
      [req.userId]
    );
    res.json({ ok: true, pulls: result.rows });
  } catch (err) {
    console.error('[pulls GET /mine]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
