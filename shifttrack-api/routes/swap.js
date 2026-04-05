const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');

// POST /api/swaps — employee requests a swap
router.post('/', auth, async (req, res) => {
  const { base_id, swap_date, note } = req.body;
  if(!base_id || !swap_date)
    return res.status(400).json({ ok:false, error:'base_id and swap_date required' });
  try {
    // Verify the base shift belongs to this user
    const check = await db.query(
      'SELECT id FROM base_schedule WHERE id=$1 AND user_id=$2',
      [base_id, req.userId]
    );
    if(!check.rows.length)
      return res.status(403).json({ ok:false, error:'Not your shift' });

    // Check no pending request already exists for this base+date
    const existing = await db.query(
      `SELECT id FROM swap_requests
       WHERE requester_id=$1 AND base_id=$2 AND swap_date=$3 AND status='pending'`,
      [req.userId, base_id, swap_date]
    );
    if(existing.rows.length)
      return res.status(409).json({ ok:false, error:'You already have a pending swap request for this shift' });

    const result = await db.query(
      `INSERT INTO swap_requests (requester_id, base_id, swap_date, note)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.userId, base_id, swap_date, note||'']
    );
    res.status(201).json({ ok:true, swap: result.rows[0] });
  } catch(err) {
    console.error(err);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// GET /api/swaps — get own swap requests
router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT sr.*, 
        b.week, b.day_of_week, b.start_time, b.end_time,
        l.name AS location_name, l.color
       FROM swap_requests sr
       JOIN base_schedule b ON sr.base_id = b.id
       JOIN locations l ON b.location_id = l.id
       WHERE sr.requester_id = $1
       ORDER BY sr.created_at DESC`,
      [req.userId]
    );
    res.json({ ok:true, swaps: result.rows });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// DELETE /api/swaps/:id — cancel own pending request
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM swap_requests
       WHERE id=$1 AND requester_id=$2 AND status='pending' RETURNING id`,
      [req.params.id, req.userId]
    );
    if(!result.rows.length)
      return res.status(404).json({ ok:false, error:'Request not found or already processed' });
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// ── Admin routes ──

function adminOnly(req, res, next){
  if(req.role !== 'admin')
    return res.status(403).json({ ok:false, error:'Admin only' });
  next();
}

// GET /api/swaps/admin/all — all swap requests
router.get('/admin/all', auth, adminOnly, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT sr.*,
        u.name AS requester_name, u.email AS requester_email,
        b.week, b.day_of_week, b.start_time, b.end_time,
        l.name AS location_name, l.color
       FROM swap_requests sr
       JOIN users u ON sr.requester_id = u.id
       JOIN base_schedule b ON sr.base_id = b.id
       JOIN locations l ON b.location_id = l.id
       ORDER BY sr.created_at DESC`
    );
    res.json({ ok:true, swaps: result.rows });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// PATCH /api/swaps/admin/:id — approve or deny
router.patch('/admin/:id', auth, adminOnly, async (req, res) => {
  const { status, admin_note } = req.body;
  if(!['approved','denied'].includes(status))
    return res.status(400).json({ ok:false, error:'status must be approved or denied' });
  try {
    const result = await db.query(
      `UPDATE swap_requests
       SET status=$1, admin_note=$2
       WHERE id=$3 AND status='pending'
       RETURNING *`,
      [status, admin_note||'', req.params.id]
    );
    if(!result.rows.length)
      return res.status(404).json({ ok:false, error:'Request not found or already processed' });
    res.json({ ok:true, swap: result.rows[0] });
  } catch(err) {
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

module.exports = router;