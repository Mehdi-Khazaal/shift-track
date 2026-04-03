const express  = require('express');
const router   = express.Router();
const db       = require('../db/index');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');

// POST /api/auth/register — admin only via secret key
router.post('/register', async (req, res) => {
  const { email, name, password, adminKey } = req.body;

  // Check secret admin key
  if(adminKey !== process.env.ADMIN_KEY)
    return res.status(403).json({ ok: false, error: 'Not authorized' });

  if (!email || !password)
    return res.status(400).json({ ok: false, error: 'email and password are required' });

  try {
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0)
      return res.status(409).json({ ok: false, error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name, role',
      [email, name||email.split('@')[0], hash]
    );
    const user = result.rows[0];
    await db.query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id]);
    const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ ok: true, token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});