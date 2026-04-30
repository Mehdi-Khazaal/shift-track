const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');

function adminOnly(req, res, next){
  if(req.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
  next();
}

// GET /api/locations
router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        l.*,
        r.name           AS region_name,
        r.office_address AS region_office_address,
        u.name           AS specialist_name,
        u.email          AS specialist_email
      FROM locations l
      LEFT JOIN regions r ON r.id = l.region_id
      LEFT JOIN users   u ON u.id = l.specialist_id
      ORDER BY r.name ASC NULLS LAST, l.name ASC
    `);
    res.json({ ok: true, locations: result.rows });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/locations
router.post('/', auth, adminOnly, async (req, res) => {
  const { name, color, rate, address, region_id, specialist_id, consumer_count } = req.body;
  if(!name || rate == null) return res.status(400).json({ ok: false, error: 'name and rate are required' });
  try {
    const result = await db.query(
      `INSERT INTO locations (name, color, rate, address, region_id, specialist_id, consumer_count, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, color || '#5b8fff', rate, address || '', region_id || null, specialist_id || null, consumer_count || 0, req.userId]
    );
    res.status(201).json({ ok: true, location: result.rows[0] });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PUT /api/locations/:id
router.put('/:id', auth, adminOnly, async (req, res) => {
  const { name, color, rate, address, region_id, specialist_id, consumer_count } = req.body;
  if(!name || rate == null) return res.status(400).json({ ok: false, error: 'name and rate are required' });
  try {
    const result = await db.query(
      `UPDATE locations
       SET name=$1, color=$2, rate=$3, address=$4, region_id=$5, specialist_id=$6, consumer_count=$7
       WHERE id=$8 RETURNING *`,
      [name, color, rate, address || '', region_id || null, specialist_id || null, consumer_count || 0, req.params.id]
    );
    if(!result.rows.length) return res.status(404).json({ ok: false, error: 'Location not found' });
    res.json({ ok: true, location: result.rows[0] });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/locations/:id
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM locations WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
