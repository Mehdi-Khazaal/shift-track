const jwt = require('jsonwebtoken');
const db = require('../db/index');

module.exports = async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ ok: false, error: 'No token provided' });

  const token = header.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }

  try {
    const result = await db.query(
      'SELECT id, role, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (!result.rows.length)
      return res.status(401).json({ ok: false, error: 'Invalid or expired token' });

    const user = result.rows[0];
    if (user.is_active === false)
      return res.status(403).json({ ok: false, error: 'This account has been deactivated. Contact your administrator.' });

    req.userId = user.id;
    req.role   = user.role;
    next();
  } catch (err) {
    console.error('[auth]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
};
