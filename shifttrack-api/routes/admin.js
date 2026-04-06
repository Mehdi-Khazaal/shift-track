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

// GET /api/admin/users — all users with basic info
router.get('/users', auth, adminOnly, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.email, u.name, u.role, u.position, u.location_id, u.created_at,
              l.name AS location_name, l.color AS location_color
       FROM users u
       LEFT JOIN locations l ON u.location_id = l.id
       ORDER BY u.created_at ASC`
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

// DELETE /api/admin/users/:id
router.delete('/users/:id', auth, adminOnly, async (req, res) => {
  if(req.params.id === req.userId)
    return res.status(400).json({ ok:false, error:"Can't delete yourself" });
  try {
    await db.query('DELETE FROM users WHERE id=$1', [req.params.id]);
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
  try {
    const existing = await db.query('SELECT id FROM users WHERE email=$1', [email]);
    if(existing.rows.length)
      return res.status(409).json({ ok:false, error:'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (email, name, password_hash, position, location_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role, position, location_id',
      [email, name||email.split('@')[0], hash, position||'', location_id||null]
    );
    const user = result.rows[0];
    await db.query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id]);
    res.status(201).json({ ok:true, user });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// PATCH /api/admin/users/:id — update user info (name, email, role, position, location, optional password)
router.patch('/users/:id', auth, adminOnly, async (req, res) => {
  const { name, email, role, position, location_id, password } = req.body;
  if(!['admin','user'].includes(role))
    return res.status(400).json({ ok:false, error:'Invalid role' });
  try {
    let result;
    if(password && password.length >= 4) {
      const hash = await bcrypt.hash(password, 10);
      result = await db.query(
        `UPDATE users SET name=$1, email=$2, role=$3, position=$4, location_id=$5, password_hash=$6
         WHERE id=$7 RETURNING id, email, name, role, position, location_id`,
        [name, email, role, position||'', location_id||null, hash, req.params.id]
      );
    } else {
      result = await db.query(
        `UPDATE users SET name=$1, email=$2, role=$3, position=$4, location_id=$5
         WHERE id=$6 RETURNING id, email, name, role, position, location_id`,
        [name, email, role, position||'', location_id||null, req.params.id]
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
  if(!password || password.length < 4)
    return res.status(400).json({ ok:false, error:'Password must be at least 4 characters' });
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

// POST /api/admin/schedule — add base shift for any user
router.post('/schedule', auth, adminOnly, async (req, res) => {
  const { user_id, week, day_of_week, location_id, start_time, end_time } = req.body;
  if(!user_id||!week||day_of_week===undefined||!location_id||!start_time||!end_time)
    return res.status(400).json({ ok:false, error:'All fields required' });
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

module.exports = router;