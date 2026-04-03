const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');

// GET /api/locations
router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM locations ORDER BY name ASC'
    );
    res.json({ ok: true, locations: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/locations
router.post('/', auth, async (req, res) => {
  const { name, color, rate } = req.body;
  if (!name || !rate)
    return res.status(400).json({ ok: false, error: 'name and rate are required' });
  try {
    const result = await db.query(
      'INSERT INTO locations (name, color, rate, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, color || '#5b8fff', rate, req.userId]
    );
    res.status(201).json({ ok: true, location: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PUT /api/locations/:id
router.put('/:id', auth, async (req, res) => {
  const { name, color, rate } = req.body;
  try {
    const result = await db.query(
      'UPDATE locations SET name=$1, color=$2, rate=$3 WHERE id=$4 RETURNING *',
      [name, color, rate, req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ ok: false, error: 'Location not found' });
    res.json({ ok: true, location: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/locations/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM locations WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;