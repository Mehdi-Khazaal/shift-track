const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');

// GET /api/unavailability
router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM user_unavailability WHERE user_id=$1 ORDER BY start_date, start_time NULLS FIRST`,
      [req.userId]
    );
    res.json({ ok: true, entries: result.rows });
  } catch(err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/unavailability
router.post('/', auth, async (req, res) => {
  const { start_date, end_date, start_time, end_time, note } = req.body;
  if(!start_date || !end_date)
    return res.status(400).json({ ok: false, error: 'start_date and end_date are required' });
  if(end_date < start_date)
    return res.status(400).json({ ok: false, error: 'end_date must be on or after start_date' });
  try {
    const result = await db.query(
      `INSERT INTO user_unavailability (user_id, start_date, end_date, start_time, end_time, note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.userId, start_date, end_date, start_time||null, end_time||null, note||'']
    );
    res.status(201).json({ ok: true, entry: result.rows[0] });
  } catch(err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/unavailability/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM user_unavailability WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch(err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
