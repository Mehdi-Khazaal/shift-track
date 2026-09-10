const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth = require('../middleware/auth');
const { adminOnly, invalidateUserCache } = require('../middleware/auth');
const bcrypt  = require('bcrypt');
const { sendPushToUser } = require('../utils/push');
const {
  MAX_SHIFT_MINS,
  shiftDurationMins,
  checkConsecutiveHours,
  overlapsExistingShift,
  overlapsBaseSchedule,
  isAcceptedSwapShift,
} = require('../utils/shiftRules');

// GET /api/admin/users - all users (active and inactive) with basic info
router.get('/users', auth, adminOnly, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.email, u.name, u.role, u.position, u.work_type, u.gender, u.location_id, u.hire_date, u.is_active, u.created_at,
              l.name AS location_name, l.color AS location_color
       FROM users u
       LEFT JOIN locations l ON u.location_id = l.id
       ORDER BY u.is_active DESC, u.created_at ASC`
    );
    res.json({ ok: true, users: result.rows });
  } catch (err) {
    console.error('[admin/users GET]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/admin/users/:id/shifts - all shifts for a user
router.get('/users/:id/shifts', auth, adminOnly, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT s.*, l.name AS location_name, l.color, l.rate,
              fl.name AS from_location_name, fl.color AS from_location_color
       FROM shifts s
       JOIN locations l ON s.location_id = l.id
       LEFT JOIN locations fl ON s.pulled_from_location_id = fl.id
       WHERE s.user_id = $1
       ORDER BY s.date DESC, s.start_time DESC`,
      [req.params.id]
    );
    res.json({ ok: true, shifts: result.rows });
  } catch (err) {
    console.error('[admin/users/:id/shifts GET]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/admin/users/:id/schedule - base schedule for a user
router.get('/users/:id/schedule', auth, adminOnly, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT b.*, l.name AS location_name, l.color, l.rate
       FROM base_schedule b
       JOIN locations l ON b.location_id = l.id
       WHERE b.user_id = $1
       ORDER BY b.week, b.day_of_week`,
      [req.params.id]
    );
    res.json({ ok: true, schedule: result.rows });
  } catch (err) {
    console.error('[admin/users/:id/schedule GET]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/admin/users/:id - permanent hard delete (only allowed on inactive users)
router.delete('/users/:id', auth, adminOnly, async (req, res) => {
  if (req.params.id === req.userId)
    return res.status(400).json({ ok: false, error: "Can't delete your own account" });
  try {
    const check = await db.query('SELECT is_active FROM users WHERE id=$1', [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
    if (check.rows[0].is_active)
      return res.status(400).json({ ok: false, error: 'Deactivate the user before permanently deleting them' });
    await db.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/users DELETE]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PATCH /api/admin/users/:id/deactivate - soft-delete (preserves all history)
router.patch('/users/:id/deactivate', auth, adminOnly, async (req, res) => {
  if (req.params.id === req.userId)
    return res.status(400).json({ ok: false, error: "Can't deactivate your own account" });
  try {
    const result = await db.query(
      `UPDATE users SET is_active=FALSE WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
    invalidateUserCache(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/users/deactivate]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PATCH /api/admin/users/:id/reactivate
router.patch('/users/:id/reactivate', auth, adminOnly, async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE users SET is_active=TRUE WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
    invalidateUserCache(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/users/reactivate]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/admin/users - create account (admin only)
router.post('/users', auth, adminOnly, async (req, res) => {
  const { email, name, password, position, location_id, role = 'user', work_type = 'regular', gender = '' } = req.body;
  if (!email || !password)
    return res.status(400).json({ ok: false, error: 'email and password required' });
  if (!['admin', 'user', 'specialist'].includes(role))
    return res.status(400).json({ ok: false, error: 'Invalid role' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ ok: false, error: 'Invalid email address' });
  if (password.length < 8)
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  const workType = ['block', 'regular'].includes(work_type) ? work_type : 'regular';
  const userGender = ['male', 'female'].includes(gender) ? gender : '';
  try {
    const existing = await db.query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.rows.length)
      return res.status(409).json({ ok: false, error: 'Email already registered' });
    const { hire_date } = req.body;
    if (!hire_date) return res.status(400).json({ ok: false, error: 'Hire date is required' });
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (email, name, password_hash, role, position, location_id, hire_date, work_type, gender) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, email, name, role, position, location_id, hire_date, work_type, gender',
      [email, name || email.split('@')[0], hash, role, position || '', location_id || null, hire_date, workType, userGender]
    );
    const user = result.rows[0];
    await db.query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id]);
    res.status(201).json({ ok: true, user });
  } catch (err) {
    console.error('[admin/users POST]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PATCH /api/admin/users/:id - update user info
router.patch('/users/:id', auth, adminOnly, async (req, res) => {
  const { name, email, role, position, location_id, password, hire_date, work_type, gender } = req.body;
  if (!name || !email)
    return res.status(400).json({ ok: false, error: 'name and email are required' });
  if (!['admin', 'user', 'specialist'].includes(role))
    return res.status(400).json({ ok: false, error: 'Invalid role' });
  const workType = ['block', 'regular'].includes(work_type) ? work_type : 'regular';
  const userGender = ['male', 'female'].includes(gender) ? gender : '';
  try {
    let result;
    if (password && password.length >= 8) {
      const hash = await bcrypt.hash(password, 10);
      result = await db.query(
        `UPDATE users SET name=$1, email=$2, role=$3, position=$4, location_id=$5, password_hash=$6, hire_date=$7, work_type=$8, gender=$9
         WHERE id=$10 RETURNING id, email, name, role, position, location_id, hire_date, work_type, gender`,
        [name, email, role, position || '', location_id || null, hash, hire_date || null, workType, userGender, req.params.id]
      );
    } else {
      result = await db.query(
        `UPDATE users SET name=$1, email=$2, role=$3, position=$4, location_id=$5, hire_date=$6, work_type=$7, gender=$8
         WHERE id=$9 RETURNING id, email, name, role, position, location_id, hire_date, work_type, gender`,
        [name, email, role, position || '', location_id || null, hire_date || null, workType, userGender, req.params.id]
      );
    }
    if (!result.rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
    invalidateUserCache(req.params.id);
    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error('[admin/users PATCH]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PATCH /api/admin/users/:id/role - promote/demote
router.patch('/users/:id/role', auth, adminOnly, async (req, res) => {
  const { role } = req.body;
  if (!['admin', 'user', 'specialist'].includes(role))
    return res.status(400).json({ ok: false, error: 'Invalid role' });
  try {
    const result = await db.query(
      'UPDATE users SET role=$1 WHERE id=$2 RETURNING id, email, name, role',
      [role, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
    invalidateUserCache(req.params.id);
    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error('[admin/users/role PATCH]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PATCH /api/admin/users/:id/password - reset a user's password
router.patch('/users/:id/password', auth, adminOnly, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8)
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id',
      [hash, req.params.id]
    );
    if (!result.rows.length)
      return res.status(404).json({ ok: false, error: 'User not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/users/password PATCH]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PATCH /api/admin/shifts/:id/notes - set admin note on a logged shift
router.patch('/shifts/:id/notes', auth, adminOnly, async (req, res) => {
  const { admin_notes } = req.body;
  try {
    const result = await db.query(
      `UPDATE shifts SET admin_notes=$1 WHERE id=$2 RETURNING id`,
      [admin_notes || '', req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: 'Shift not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/shifts/notes PATCH]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/admin/shifts - assign a one-off dated shift to any employee.
// Runs the same validation as the employee-facing POST /api/shifts (shared via
// utils/shiftRules) so an admin cannot create a shift the employee app rejects.
router.post('/shifts', auth, adminOnly, async (req, res) => {
  const { user_id, location_id, date, start_time, end_time, notes } = req.body;
  if (!user_id || !location_id || !date || !start_time || !end_time)
    return res.status(400).json({ ok: false, error: 'user_id, location_id, date, start_time, end_time are required' });

  if (shiftDurationMins(start_time, end_time) > MAX_SHIFT_MINS)
    return res.status(400).json({ ok: false, error: 'A single shift cannot exceed 18 hours.' });

  try {
    // Catches overnight shifts and shifts on the adjacent day that spill past
    // midnight, not just same-date clock-time collisions.
    if (await overlapsExistingShift(user_id, date, start_time, end_time))
      return res.status(409).json({ ok: false, error: 'This employee already has a shift that overlaps those hours' });

    if (await overlapsBaseSchedule(user_id, date, start_time, end_time))
      return res.status(409).json({ ok: false, error: 'This shift overlaps their base schedule on that day' });

    const chainErr = await checkConsecutiveHours(user_id, date, start_time, end_time);
    if (chainErr)
      return res.status(409).json({ ok: false, error: chainErr });

    const result = await db.query(
      `INSERT INTO shifts (user_id, location_id, date, start_time, end_time, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [user_id, location_id, date, start_time, end_time, notes || '']
    );

    const locRes  = await db.query('SELECT name FROM locations WHERE id=$1', [location_id]);
    const locName = locRes.rows[0]?.name || 'a location';
    sendPushToUser(
      user_id,
      'Shift Assigned',
      `You've been assigned a shift at ${locName} on ${date}, ${start_time.slice(0, 5)}-${end_time.slice(0, 5)}.`
    ).catch(e => console.error('[admin/shifts POST] push failed:', e.message));

    res.status(201).json({ ok: true, shift: result.rows[0] });
  } catch (err) {
    console.error('[admin/shifts POST]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/admin/shifts/:id - remove any employee's one-off shift.
// Unlike the employee route this DOES allow deleting awarded (open-shift) shifts,
// which is the case the employee app defers to an admin for. Pulled and swapped
// shifts are still refused: their rows in pulls / shift_swaps reference this
// shift, and the dedicated undo flows unwind both sides transactionally.
router.delete('/shifts/:id', auth, adminOnly, async (req, res) => {
  try {
    const check = await db.query(
      'SELECT user_id, date, is_pulled FROM shifts WHERE id=$1',
      [req.params.id]
    );
    if (!check.rows.length) return res.json({ ok: true });
    const shift = check.rows[0];

    if (shift.is_pulled)
      return res.status(409).json({ ok: false, error: 'This is a pulled shift - undo the pull instead.' });
    if (await isAcceptedSwapShift(shift.user_id, req.params.id))
      return res.status(409).json({ ok: false, error: 'This shift came from an accepted swap - reject the swap instead.' });

    await db.query('DELETE FROM shifts WHERE id=$1', [req.params.id]);

    const dateStr = String(shift.date).slice(0, 10);
    sendPushToUser(
      shift.user_id,
      'Shift Removed',
      `Your shift on ${dateStr} has been removed by an administrator.`
    ).catch(e => console.error('[admin/shifts DELETE] push failed:', e.message));

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/shifts DELETE]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/admin/suppress-date - cancel ONE occurrence of a user's recurring
// base schedule without touching the recurring pattern itself. Same mechanism
// pulls already use (routes/pulls.js).
router.post('/suppress-date', auth, adminOnly, async (req, res) => {
  const { user_id, date } = req.body;
  if (!user_id || !date)
    return res.status(400).json({ ok: false, error: 'user_id and date are required' });
  try {
    await db.query(
      'INSERT INTO base_suppressed_dates (user_id, date) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [user_id, date]
    );
    sendPushToUser(
      user_id,
      'Shift Removed',
      `Your scheduled shift on ${date} has been cancelled by an administrator.`
    ).catch(e => console.error('[admin/suppress-date POST] push failed:', e.message));
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/suppress-date POST]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/admin/suppress-date - restore a cancelled base occurrence.
// Makes the cancel above reversible.
router.delete('/suppress-date', auth, adminOnly, async (req, res) => {
  const { user_id, date } = req.body;
  if (!user_id || !date)
    return res.status(400).json({ ok: false, error: 'user_id and date are required' });
  try {
    await db.query('DELETE FROM base_suppressed_dates WHERE user_id=$1 AND date=$2', [user_id, date]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/suppress-date DELETE]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/admin/schedule - add base shift for any user
router.post('/schedule', auth, adminOnly, async (req, res) => {
  const { user_id, week, day_of_week, location_id, start_time, end_time } = req.body;
  if (!user_id || !week || day_of_week === undefined || !location_id || !start_time || !end_time)
    return res.status(400).json({ ok: false, error: 'All fields required' });
  if (![1, 2].includes(Number(week)))
    return res.status(400).json({ ok: false, error: 'week must be 1 or 2' });
  const dow = Number(day_of_week);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6)
    return res.status(400).json({ ok: false, error: 'day_of_week must be 0-6' });
  try {
    const result = await db.query(
      `INSERT INTO base_schedule (user_id,week,day_of_week,location_id,start_time,end_time)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [user_id, week, day_of_week, location_id, start_time, end_time]
    );
    res.status(201).json({ ok: true, entry: result.rows[0] });
  } catch (err) {
    console.error('[admin/schedule POST]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/admin/schedule/:id - remove base shift
router.delete('/schedule/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM base_schedule WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/schedule DELETE]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/admin/users/:id/schedule - clear all base shifts for a user
router.delete('/users/:id/schedule', auth, adminOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM base_schedule WHERE user_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/users/:id/schedule DELETE]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/admin/swaps - all swaps visible to admin
router.get('/swaps', auth, adminOnly, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ss.*,
              u_i.name AS initiator_name,
              u_t.name AS target_name,
              l_i.name AS initiator_location_name,
              l_t.name AS target_location_name
       FROM shift_swaps ss
       JOIN users u_i ON ss.initiator_id = u_i.id
       JOIN users u_t ON ss.target_id    = u_t.id
       JOIN locations l_i ON ss.initiator_location_id = l_i.id
       JOIN locations l_t ON ss.target_location_id    = l_t.id
       ORDER BY ss.created_at DESC
       LIMIT 100`
    );
    res.json({ ok: true, swaps: result.rows });
  } catch (err) {
    console.error('[admin/swaps GET]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PATCH /api/admin/swaps/:id/reject - admin rejects/undoes any swap
router.patch('/swaps/:id/reject', auth, adminOnly, async (req, res) => {
  try {
    const swapRes = await db.query(
      `SELECT ss.*, u_i.name AS initiator_name, u_t.name AS target_name
       FROM shift_swaps ss
       JOIN users u_i ON ss.initiator_id = u_i.id
       JOIN users u_t ON ss.target_id    = u_t.id
       WHERE ss.id = $1`,
      [req.params.id]
    );
    if (!swapRes.rows.length)
      return res.status(404).json({ ok: false, error: 'Swap not found' });
    const swap = swapRes.rows[0];

    if (swap.status === 'cancelled')
      return res.status(409).json({ ok: false, error: 'Swap already cancelled' });

    if (swap.status === 'accepted') {
      const iDate = swap.initiator_date;
      const tDate = swap.target_date;

      // Wrap all undo operations in a transaction so partial failure can't corrupt data
      const client = await db.connect();
      try {
        await client.query('BEGIN');

        if (swap.swapped_initiator_shift_id)
          await client.query('DELETE FROM shifts WHERE id=$1', [swap.swapped_initiator_shift_id]);
        if (swap.swapped_target_shift_id)
          await client.query('DELETE FROM shifts WHERE id=$1', [swap.swapped_target_shift_id]);

        if (swap.initiator_is_base) {
          await client.query('DELETE FROM base_suppressed_dates WHERE user_id=$1 AND date=$2',
            [swap.initiator_id, iDate]);
        } else if (swap.initiator_shift_id) {
          await client.query(
            `INSERT INTO shifts (id, user_id, location_id, date, start_time, end_time, notes)
             VALUES ($1,$2,$3,$4,$5,$6,'') ON CONFLICT DO NOTHING`,
            [swap.initiator_shift_id, swap.initiator_id, swap.initiator_location_id, iDate,
             swap.initiator_start, swap.initiator_end]
          );
        }

        if (swap.target_is_base) {
          await client.query('DELETE FROM base_suppressed_dates WHERE user_id=$1 AND date=$2',
            [swap.target_id, tDate]);
        } else if (swap.target_shift_id) {
          await client.query(
            `INSERT INTO shifts (id, user_id, location_id, date, start_time, end_time, notes)
             VALUES ($1,$2,$3,$4,$5,$6,'') ON CONFLICT DO NOTHING`,
            [swap.target_shift_id, swap.target_id, swap.target_location_id, tDate,
             swap.target_start, swap.target_end]
          );
        }

        await client.query(
          `UPDATE shift_swaps SET status='cancelled', responded_at=NOW() WHERE id=$1`,
          [req.params.id]
        );

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }
    } else {
      await db.query(
        `UPDATE shift_swaps SET status='cancelled', responded_at=NOW() WHERE id=$1`,
        [req.params.id]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/swaps reject]', err);
    res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
});

// GET /api/admin/suppressed-dates - all base schedule suppression entries
router.get('/suppressed-dates', auth, adminOnly, async (req, res) => {
  try {
    const result = await db.query('SELECT user_id, date FROM base_suppressed_dates');
    res.json({ ok: true, suppressed: result.rows });
  } catch (err) {
    console.error('[admin/suppressed-dates GET]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
