const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');

// GET /api/settings
router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM user_settings WHERE user_id=$1', [req.userId]
    );
    if(!result.rows.length)
      return res.json({ ok:true, settings:{ ot_threshold:40, pp_anchor:'2026-03-22' } });
    res.json({ ok: true, settings: result.rows[0] });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PUT /api/settings
router.put('/', auth, async (req, res) => {
  const { ot_threshold, pp_anchor } = req.body;
  try {
    const result = await db.query(
      `INSERT INTO user_settings (user_id, ot_threshold, pp_anchor)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE
       SET ot_threshold=$2, pp_anchor=$3
       RETURNING *`,
      [req.userId, ot_threshold||40, pp_anchor||'2026-03-22']
    );
    res.json({ ok: true, settings: result.rows[0] });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;