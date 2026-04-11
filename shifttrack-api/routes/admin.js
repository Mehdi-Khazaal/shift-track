const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');

// Middleware — admin only
function adminOnly(req, res, next){
  if(req.role !== 'admin')
    return res.status(403).json({ ok:false, error:'Admin access required' });
  next();
}

// GET /api/admin/users — all users (active and inactive) with basic info
router.get('/users', auth, adminOnly, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.email, u.name, u.role, u.position, u.location_id, u.hire_date, u.is_active, u.created_at,
              l.name AS location_name, l.color AS location_color
       FROM users u
       LEFT JOIN locations l ON u.location_id = l.id
       ORDER BY u.is_active DESC, u.created_at ASC`
    );
    res.json({ ok:true, users: result.rows });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// GET /api/admin/users/:id/shifts — all shifts for a user
router.get('/users/:id/shifts', auth, adminOnly, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT s.*, l.name AS location_name, l.color, l.rate
       FROM shifts s
       JOIN locations l ON s.location_id = l.id
       WHERE s.user_id = $1
       ORDER BY s.date DESC, s.start_time DESC`,
      [req.params.id]
    );
    res.json({ ok:true, shifts: result.rows });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// GET /api/admin/users/:id/schedule — base schedule for a user
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
    res.json({ ok:true, schedule: result.rows });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// PATCH /api/admin/users/:id/deactivate — soft-delete (preserves all history)
router.patch('/users/:id/deactivate', auth, adminOnly, async (req, res) => {
  if(req.params.id === req.userId)
    return res.status(400).json({ ok:false, error:"Can't deactivate your own account" });
  try {
    const result = await db.query(
      `UPDATE users SET is_active=FALSE WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if(!result.rows.length) return res.status(404).json({ ok:false, error:'User not found' });
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// PATCH /api/admin/users/:id/reactivate
router.patch('/users/:id/reactivate', auth, adminOnly, async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE users SET is_active=TRUE WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if(!result.rows.length) return res.status(404).json({ ok:false, error:'User not found' });
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// POST /api/admin/users — create account (admin only)
router.post('/users', auth, adminOnly, async (req, res) => {
  const { email, name, password, position, location_id } = req.body;
  if(!email || !password)
    return res.status(400).json({ ok:false, error:'email and password required' });
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ ok:false, error:'Invalid email address' });
  if(password.length < 8)
    return res.status(400).json({ ok:false, error:'Password must be at least 8 characters' });
  try {
    const existing = await db.query('SELECT id FROM users WHERE email=$1', [email]);
    if(existing.rows.length)
      return res.status(409).json({ ok:false, error:'Email already registered' });
    const { hire_date } = req.body;
    if(!hire_date) return res.status(400).json({ ok:false, error:'Hire date is required' });
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (email, name, password_hash, position, location_id, hire_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, name, role, position, location_id, hire_date',
      [email, name||email.split('@')[0], hash, position||'', location_id||null, hire_date]
    );
    const user = result.rows[0];
    await db.query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id]);
    res.status(201).json({ ok:true, user });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// PATCH /api/admin/users/:id — update user info (name, email, role, position, location, hire_date, optional password)
router.patch('/users/:id', auth, adminOnly, async (req, res) => {
  const { name, email, role, position, location_id, password, hire_date } = req.body;
  if(!name || !email)
    return res.status(400).json({ ok:false, error:'name and email are required' });
  if(!['admin','user'].includes(role))
    return res.status(400).json({ ok:false, error:'Invalid role' });
  try {
    let result;
    if(password && password.length >= 8) {
      const hash = await bcrypt.hash(password, 10);
      result = await db.query(
        `UPDATE users SET name=$1, email=$2, role=$3, position=$4, location_id=$5, password_hash=$6, hire_date=$7
         WHERE id=$8 RETURNING id, email, name, role, position, location_id, hire_date`,
        [name, email, role, position||'', location_id||null, hash, hire_date||null, req.params.id]
      );
    } else {
      result = await db.query(
        `UPDATE users SET name=$1, email=$2, role=$3, position=$4, location_id=$5, hire_date=$6
         WHERE id=$7 RETURNING id, email, name, role, position, location_id, hire_date`,
        [name, email, role, position||'', location_id||null, hire_date||null, req.params.id]
      );
    }
    if(!result.rows.length) return res.status(404).json({ ok:false, error:'User not found' });
    res.json({ ok:true, user: result.rows[0] });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// PATCH /api/admin/users/:id/role — promote/demote
router.patch('/users/:id/role', auth, adminOnly, async (req, res) => {
  const { role } = req.body;
  if(!['admin','user'].includes(role))
    return res.status(400).json({ ok:false, error:'Invalid role' });
  try {
    const result = await db.query(
      'UPDATE users SET role=$1 WHERE id=$2 RETURNING id, email, name, role',
      [role, req.params.id]
    );
    res.json({ ok:true, user: result.rows[0] });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// PATCH /api/admin/users/:id/password — reset a user's password
router.patch('/users/:id/password', auth, adminOnly, async (req, res) => {
  const { password } = req.body;
  if(!password || password.length < 8)
    return res.status(400).json({ ok:false, error:'Password must be at least 8 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id',
      [hash, req.params.id]
    );
    if(!result.rows.length)
      return res.status(404).json({ ok:false, error:'User not found' });
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// PATCH /api/admin/shifts/:id/notes — set admin note on a logged shift
router.patch('/shifts/:id/notes', auth, adminOnly, async (req, res) => {
  const { admin_notes } = req.body;
  try {
    const result = await db.query(
      `UPDATE shifts SET admin_notes=$1 WHERE id=$2 RETURNING id`,
      [admin_notes || '', req.params.id]
    );
    if(!result.rows.length) return res.status(404).json({ ok:false, error:'Shift not found' });
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// POST /api/admin/schedule — add base shift for any user
router.post('/schedule', auth, adminOnly, async (req, res) => {
  const { user_id, week, day_of_week, location_id, start_time, end_time } = req.body;
  if(!user_id||!week||day_of_week===undefined||!location_id||!start_time||!end_time)
    return res.status(400).json({ ok:false, error:'All fields required' });
  if(![1,2].includes(Number(week)))
    return res.status(400).json({ ok:false, error:'week must be 1 or 2' });
  const dow = Number(day_of_week);
  if(!Number.isInteger(dow) || dow < 0 || dow > 6)
    return res.status(400).json({ ok:false, error:'day_of_week must be 0–6' });
  try {
    const result = await db.query(
      `INSERT INTO base_schedule (user_id,week,day_of_week,location_id,start_time,end_time)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [user_id,week,day_of_week,location_id,start_time,end_time]
    );
    res.status(201).json({ ok:true, entry:result.rows[0] });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// DELETE /api/admin/schedule/:id — remove base shift
router.delete('/schedule/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM base_schedule WHERE id=$1',[req.params.id]);
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// GET /api/admin/swaps — all swaps visible to admin
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
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PATCH /api/admin/swaps/:id/reject — admin rejects/undoes any swap
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

    // If accepted we need to undo the shift changes
    if (swap.status === 'accepted') {
      const iDate = swap.initiator_date;
      const tDate = swap.target_date;

      // Remove the concrete swapped shifts by their stored IDs (exact, no string matching)
      if (swap.swapped_initiator_shift_id)
        await db.query('DELETE FROM shifts WHERE id=$1', [swap.swapped_initiator_shift_id]);
      if (swap.swapped_target_shift_id)
        await db.query('DELETE FROM shifts WHERE id=$1', [swap.swapped_target_shift_id]);

      // Restore initiator's original slot
      if (swap.initiator_is_base) {
        await db.query('DELETE FROM base_suppressed_dates WHERE user_id=$1 AND date=$2',
          [swap.initiator_id, iDate]);
      } else if (swap.initiator_shift_id) {
        await db.query(
          `INSERT INTO shifts (id, user_id, location_id, date, start_time, end_time, notes)
           VALUES ($1,$2,$3,$4,$5,$6,'') ON CONFLICT DO NOTHING`,
          [swap.initiator_shift_id, swap.initiator_id, swap.initiator_location_id, iDate,
           swap.initiator_start, swap.initiator_end]
        );
      }

      // Restore target's original slot
      if (swap.target_is_base) {
        await db.query('DELETE FROM base_suppressed_dates WHERE user_id=$1 AND date=$2',
          [swap.target_id, tDate]);
      } else if (swap.target_shift_id) {
        await db.query(
          `INSERT INTO shifts (id, user_id, location_id, date, start_time, end_time, notes)
           VALUES ($1,$2,$3,$4,$5,$6,'') ON CONFLICT DO NOTHING`,
          [swap.target_shift_id, swap.target_id, swap.target_location_id, tDate,
           swap.target_start, swap.target_end]
        );
      }
    }

    await db.query(
      `UPDATE shift_swaps SET status='cancelled', responded_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin swap reject]', err);
    res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
});

// GET /api/admin/suppressed-dates — all base schedule suppression entries
router.get('/suppressed-dates', auth, adminOnly, async (req, res) => {
  try {
    const result = await db.query('SELECT user_id, date FROM base_suppressed_dates');
    res.json({ ok: true, suppressed: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;