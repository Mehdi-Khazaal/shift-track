const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');

// GET /api/schedule
router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT s.*, l.name AS location_name, l.color, l.rate
       FROM base_schedule s
       JOIN locations l ON s.location_id = l.id
       WHERE s.user_id = $1
       ORDER BY s.week, s.day_of_week, s.start_time`,
      [req.userId]
    );
    res.json({ ok: true, schedule: result.rows });
  } catch(err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/schedule
router.post('/', auth, async (req, res) => {
  const { week, day_of_week, location_id, start_time, end_time } = req.body;
  if(!week||day_of_week===undefined||!location_id||!start_time||!end_time)
    return res.status(400).json({ ok: false, error: 'All fields required' });
  if(![1,2].includes(Number(week)))
    return res.status(400).json({ ok: false, error: 'week must be 1 or 2' });
  const dow = Number(day_of_week);
  if(!Number.isInteger(dow) || dow < 0 || dow > 6)
    return res.status(400).json({ ok: false, error: 'day_of_week must be 0-6' });
  try {
    const result = await db.query(
      `INSERT INTO base_schedule (user_id, week, day_of_week, location_id, start_time, end_time)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.userId, week, day_of_week, location_id, start_time, end_time]
    );
    res.status(201).json({ ok: true, entry: result.rows[0] });
  } catch(err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PUT /api/schedule/:id
router.put('/:id', auth, async (req, res) => {
  const { week, day_of_week, location_id, start_time, end_time } = req.body;
  try {
    const result = await db.query(
      `UPDATE base_schedule SET week=$1,day_of_week=$2,location_id=$3,start_time=$4,end_time=$5
       WHERE id=$6 AND user_id=$7 RETURNING *`,
      [week, day_of_week, location_id, start_time, end_time, req.params.id, req.userId]
    );
    if(!result.rows.length)
      return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, entry: result.rows[0] });
  } catch(err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/schedule/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM base_schedule WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;