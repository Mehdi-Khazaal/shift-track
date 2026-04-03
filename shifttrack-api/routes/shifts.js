const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');

// GET /api/shifts — get all shifts for logged-in user
router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT s.*, l.name AS location_name, l.color, l.rate
       FROM shifts s
       JOIN locations l ON s.location_id = l.id
       WHERE s.user_id = $1
       ORDER BY s.date DESC, s.start_time DESC`,
      [req.userId]
    );
    res.json({ ok: true, shifts: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/shifts — log a new shift
router.post('/', auth, async (req, res) => {
  const { location_id, date, start_time, end_time, notes } = req.body;
  if (!location_id || !date || !start_time || !end_time)
    return res.status(400).json({ ok: false, error: 'location_id, date, start_time, end_time are required' });

  try {
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

// PUT /api/shifts/:id — edit a shift
router.put('/:id', auth, async (req, res) => {
  const { location_id, date, start_time, end_time, notes } = req.body;
  try {
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
    await db.query('DELETE FROM shifts WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;