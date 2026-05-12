const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');
const { adminOnly } = require('../middleware/auth');
const { sendPushToUser } = require('../utils/push');

async function rateOverrideForMode(client, fromLocationId, payRateMode) {
  if (payRateMode !== 'original') return null;
  const rateRes = await client.query('SELECT rate FROM locations WHERE id=$1', [fromLocationId]);
  return rateRes.rows[0]?.rate ?? null;
}

// POST /api/pulls/admin - admin creates a pull
router.post('/admin', auth, adminOnly, async (req, res) => {
  const {
    user_id, shift_id, from_location_id, to_location_id,
    pull_date, shift_start, shift_end, has_bonus,
    pay_rate_mode = 'destination'
  } = req.body;
  if (!user_id || !to_location_id || !pull_date || !shift_start || !shift_end)
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  if (!['destination', 'original'].includes(pay_rate_mode))
    return res.status(400).json({ ok: false, error: 'Invalid pay rate mode' });

  const bonusAmount = has_bonus ? 50.00 : 0.00;
  const isBaseShift = !shift_id;
  const client = await db.connect();

  try {
    let finalShiftId = shift_id || null;
    let fromLocId = from_location_id || null;
    let toLocName = 'another location';
    let pull;

    await client.query('BEGIN');

    const toLoc = await client.query('SELECT name FROM locations WHERE id=$1', [to_location_id]);
    if (!toLoc.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Destination location not found' });
    }
    toLocName = toLoc.rows[0].name || toLocName;

    const duplicate = await client.query(
      `SELECT id FROM shift_pulls
       WHERE user_id=$1
         AND pull_date=$2
         AND shift_start=$3
         AND shift_end=$4
         AND undone_at IS NULL
       LIMIT 1`,
      [user_id, pull_date, shift_start, shift_end]
    );
    if (duplicate.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'This shift already has an active pull' });
    }

    if (shift_id) {
      const shiftRes = await client.query('SELECT * FROM shifts WHERE id=$1 AND user_id=$2 FOR UPDATE', [shift_id, user_id]);
      if (!shiftRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'Shift not found' });
      }
      if (shiftRes.rows[0].is_pulled) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, error: 'This shift is already pulled' });
      }

      fromLocId = shiftRes.rows[0].location_id;
      if (fromLocId === to_location_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'Destination must be different from the current location' });
      }
      const payRateOverride = await rateOverrideForMode(client, fromLocId, pay_rate_mode);

      await client.query(
        `UPDATE shifts
         SET location_id=$1, is_pulled=TRUE, pulled_from_location_id=$2, pull_bonus=$3, pay_rate_override=$4
         WHERE id=$5`,
        [to_location_id, fromLocId, bonusAmount, payRateOverride, shift_id]
      );
    } else {
      if (!fromLocId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'Original location is required for base shift pulls' });
      }
      if (fromLocId === to_location_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'Destination must be different from the current location' });
      }

      const suppressed = await client.query(
        'SELECT id FROM base_suppressed_dates WHERE user_id=$1 AND date=$2 LIMIT 1',
        [user_id, pull_date]
      );
      if (suppressed.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, error: 'This base shift date is already suppressed' });
      }
      const payRateOverride = await rateOverrideForMode(client, fromLocId, pay_rate_mode);

      await client.query(
        `INSERT INTO base_suppressed_dates (user_id, date)
         VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [user_id, pull_date]
      );

      const newShift = await client.query(
        `INSERT INTO shifts (user_id, location_id, date, start_time, end_time, is_pulled, pulled_from_location_id, pull_bonus, pay_rate_override)
         VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7,$8)
         RETURNING id`,
        [user_id, to_location_id, pull_date, shift_start, shift_end, fromLocId, bonusAmount, payRateOverride]
      );
      finalShiftId = newShift.rows[0].id;
    }

    const pullRes = await client.query(
      `INSERT INTO shift_pulls
         (user_id, shift_id, from_location_id, to_location_id, pull_date, shift_start, shift_end, has_bonus, bonus_amount, created_by, is_base_shift, pay_rate_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [user_id, finalShiftId, fromLocId, to_location_id, pull_date, shift_start, shift_end, has_bonus, bonusAmount, req.userId, isBaseShift, pay_rate_mode]
    );
    pull = pullRes.rows[0];

    await client.query('COMMIT');

    const dateStr = new Date(pull_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const bonusMsg = has_bonus ? ' A $50 pull bonus has been added to your paycheck.' : '';
    sendPushToUser(user_id, 'Shift Pull', `You've been pulled to ${toLocName} on ${dateStr}.${bonusMsg}`)
      .catch(err => console.warn('[pulls push]', err.message));

    res.json({ ok: true, pull });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[pulls POST /admin]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  } finally {
    client.release();
  }
});

// GET /api/pulls/admin?user_id=xxx - all pulls for a user
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

// PUT /api/pulls/admin/:id - edit an active pull
router.put('/admin/:id', auth, adminOnly, async (req, res) => {
  const { to_location_id, has_bonus, pay_rate_mode = 'destination' } = req.body;
  if (!to_location_id)
    return res.status(400).json({ ok: false, error: 'Destination location is required' });
  if (!['destination', 'original'].includes(pay_rate_mode))
    return res.status(400).json({ ok: false, error: 'Invalid pay rate mode' });

  const bonusAmount = has_bonus ? 50.00 : 0.00;
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const pullRes = await client.query('SELECT * FROM shift_pulls WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!pullRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Pull not found' });
    }

    const pull = pullRes.rows[0];
    if (pull.undone_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'Cannot edit an undone pull' });
    }
    if (!pull.shift_id || !pull.from_location_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'Pull cannot be edited because its shift is missing' });
    }
    if (pull.from_location_id === to_location_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'Destination must be different from the original location' });
    }

    const [shiftRes, toLocRes] = await Promise.all([
      client.query('SELECT id FROM shifts WHERE id=$1 FOR UPDATE', [pull.shift_id]),
      client.query('SELECT id FROM locations WHERE id=$1', [to_location_id])
    ]);
    if (!shiftRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Pulled shift not found' });
    }
    if (!toLocRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Destination location not found' });
    }

    const payRateOverride = await rateOverrideForMode(client, pull.from_location_id, pay_rate_mode);

    await client.query(
      `UPDATE shifts
       SET location_id=$1, pull_bonus=$2, pay_rate_override=$3
       WHERE id=$4`,
      [to_location_id, bonusAmount, payRateOverride, pull.shift_id]
    );

    const updated = await client.query(
      `UPDATE shift_pulls
       SET to_location_id=$1, has_bonus=$2, bonus_amount=$3, pay_rate_mode=$4
       WHERE id=$5
       RETURNING *`,
      [to_location_id, !!has_bonus, bonusAmount, pay_rate_mode, req.params.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, pull: updated.rows[0] });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[pulls PUT /admin/:id]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  } finally {
    client.release();
  }
});

// DELETE /api/pulls/admin/:id - undo a pull
router.delete('/admin/:id', auth, adminOnly, async (req, res) => {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const pullRes = await client.query('SELECT * FROM shift_pulls WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!pullRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Pull not found' });
    }

    const pull = pullRes.rows[0];
    if (pull.undone_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'Already undone' });
    }

    let shift = null;
    if (pull.shift_id) {
      const shiftRes = await client.query('SELECT * FROM shifts WHERE id=$1 FOR UPDATE', [pull.shift_id]);
      shift = shiftRes.rows[0] || null;
    }

    const suppressedRes = await client.query(
      'SELECT id FROM base_suppressed_dates WHERE user_id=$1 AND date=$2 LIMIT 1',
      [pull.user_id, pull.pull_date]
    );
    const shiftMatchesPull = shift
      && String(shift.date).slice(0, 10) === String(pull.pull_date).slice(0, 10)
      && String(shift.start_time).slice(0, 5) === String(pull.shift_start).slice(0, 5)
      && String(shift.end_time).slice(0, 5) === String(pull.shift_end).slice(0, 5);
    const shiftCreatedNearPull = shift && shift.created_at && pull.created_at
      && Math.abs(new Date(pull.created_at) - new Date(shift.created_at)) < 5 * 60 * 1000;
    const isBasePull = pull.is_base_shift || (suppressedRes.rows.length && shiftMatchesPull && shiftCreatedNearPull);

    if (isBasePull) {
      if (pull.shift_id) await client.query('DELETE FROM shifts WHERE id=$1', [pull.shift_id]);
      await client.query('DELETE FROM base_suppressed_dates WHERE user_id=$1 AND date=$2', [pull.user_id, pull.pull_date]);
    } else if (pull.shift_id && shift && pull.from_location_id) {
      await client.query(
        `UPDATE shifts
         SET location_id=$1, is_pulled=FALSE, pulled_from_location_id=NULL, pull_bonus=0, pay_rate_override=NULL
         WHERE id=$2`,
        [pull.from_location_id, pull.shift_id]
      );
    }

    await client.query('UPDATE shift_pulls SET undone_at=NOW(), undone_by=$1 WHERE id=$2', [req.userId, req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[pulls DELETE /admin/:id]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  } finally {
    client.release();
  }
});

// GET /api/pulls/mine - employee's own active pulls
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
