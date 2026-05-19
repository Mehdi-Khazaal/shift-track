const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');

function adminOnly(req, res, next){
  if(req.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
  next();
}

const POSITION_RATES = { tc: 22.25, src: 22.25, dsp: 19.25 };

function regionNameToHue(name) {
  if (!name) return 210;
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h * 33) ^ name.charCodeAt(i)) >>> 0;
  return h % 360;
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1))).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
function positionTypeColor(regionName, posType) {
  const hue = regionNameToHue(regionName || '');
  if (posType === 'tc')  return hslToHex(hue, 72, 55);
  if (posType === 'src') return hslToHex(hue, 65, 48);
  if (posType === 'dsp') return hslToHex(hue, 52, 60);
  return null;
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
  let { name, color, rate, address, phone, region_id, specialist_id, consumer_count, position_type = 'none' } = req.body;
  position_type = ['tc', 'src', 'dsp'].includes(position_type) ? position_type : 'none';
  if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
  if (POSITION_RATES[position_type] != null) {
    rate = POSITION_RATES[position_type];
  } else if (rate == null || isNaN(parseFloat(rate))) {
    return res.status(400).json({ ok: false, error: 'rate is required' });
  }
  try {
    if (position_type !== 'none') {
      const rr = region_id ? await db.query('SELECT name FROM regions WHERE id=$1', [region_id]) : { rows: [] };
      color = positionTypeColor(rr.rows[0]?.name || '', position_type) || '#5b8fff';
    }
    const result = await db.query(
      `INSERT INTO locations (name, color, rate, address, phone, region_id, specialist_id, consumer_count, position_type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [name, color || '#5b8fff', parseFloat(rate), address || '', phone || '', region_id || null, specialist_id || null, consumer_count || 0, position_type, req.userId]
    );
    res.status(201).json({ ok: true, location: result.rows[0] });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PUT /api/locations/:id
router.put('/:id', auth, adminOnly, async (req, res) => {
  let { name, color, rate, address, phone, region_id, specialist_id, consumer_count, position_type = 'none' } = req.body;
  position_type = ['tc', 'src', 'dsp'].includes(position_type) ? position_type : 'none';
  if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
  if (POSITION_RATES[position_type] != null) {
    rate = POSITION_RATES[position_type];
  } else if (rate == null || isNaN(parseFloat(rate))) {
    return res.status(400).json({ ok: false, error: 'rate is required' });
  }
  try {
    if (position_type !== 'none') {
      const rr = region_id ? await db.query('SELECT name FROM regions WHERE id=$1', [region_id]) : { rows: [] };
      color = positionTypeColor(rr.rows[0]?.name || '', position_type) || '#5b8fff';
    }
    const result = await db.query(
      `UPDATE locations
       SET name=$1, color=$2, rate=$3, address=$4, phone=$5, region_id=$6, specialist_id=$7, consumer_count=$8, position_type=$9
       WHERE id=$10 RETURNING *`,
      [name, color || '#5b8fff', parseFloat(rate), address || '', phone || '', region_id || null, specialist_id || null, consumer_count || 0, position_type, req.params.id]
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
