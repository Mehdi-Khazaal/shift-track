const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');

function adminOnly(req, res, next){
  if(req.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
  next();
}

// GET /api/regions
router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM regions ORDER BY name ASC');
    res.json({ ok: true, regions: result.rows });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/regions
router.post('/', auth, adminOnly, async (req, res) => {
  const { name, office_address } = req.body;
  if(!name) return res.status(400).json({ ok: false, error: 'name is required' });
  try {
    const result = await db.query(
      'INSERT INTO regions (name, office_address) VALUES ($1, $2) RETURNING *',
      [name.trim(), office_address?.trim() || '']
    );
    res.status(201).json({ ok: true, region: result.rows[0] });
  } catch(err) {
    if(err.code === '23505') return res.status(409).json({ ok: false, error: 'A region with that name already exists' });
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PUT /api/regions/:id
router.put('/:id', auth, adminOnly, async (req, res) => {
  const { name, office_address } = req.body;
  if(!name) return res.status(400).json({ ok: false, error: 'name is required' });
  try {
    const result = await db.query(
      'UPDATE regions SET name=$1, office_address=$2 WHERE id=$3 RETURNING *',
      [name.trim(), office_address?.trim() || '', req.params.id]
    );
    if(!result.rows.length) return res.status(404).json({ ok: false, error: 'Region not found' });
    res.json({ ok: true, region: result.rows[0] });
  } catch(err) {
    if(err.code === '23505') return res.status(409).json({ ok: false, error: 'A region with that name already exists' });
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
