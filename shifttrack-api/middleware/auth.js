const jwt = require('jsonwebtoken');
const db = require('../db/index');

// Cache account authorization state briefly to avoid a DB hit on every request.
// Role is read from the DB so role changes take effect without waiting for JWT expiry.
const activeCache = new Map();
const ACTIVE_CACHE_TTL = 60 * 1000;

function adminOnly(req, res, next) {
  if (req.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin access required' });
  next();
}

async function auth(req, res, next) {
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

  const cached = activeCache.get(decoded.userId);
  if (cached && Date.now() < cached.expiresAt) {
    if (!cached.isActive)
      return res.status(403).json({ ok: false, error: 'This account has been deactivated. Contact your administrator.' });
    req.userId = decoded.userId;
    req.role   = cached.role;
    return next();
  }

  try {
    const result = await db.query('SELECT is_active, role FROM users WHERE id = $1', [decoded.userId]);
    if (!result.rows.length)
      return res.status(401).json({ ok: false, error: 'Invalid or expired token' });

    const isActive = result.rows[0].is_active !== false;
    const role = result.rows[0].role || 'user';
    activeCache.set(decoded.userId, { isActive, role, expiresAt: Date.now() + ACTIVE_CACHE_TTL });

    if (!isActive)
      return res.status(403).json({ ok: false, error: 'This account has been deactivated. Contact your administrator.' });

    req.userId = decoded.userId;
    req.role   = role;
    next();
  } catch (err) {
    console.error('[auth]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
}

// Call when a user's authorization state changes so the next request re-checks the DB.
function invalidateUserCache(userId) {
  activeCache.delete(userId);
}

module.exports = auth;
module.exports.adminOnly = adminOnly;
module.exports.invalidateUserCache = invalidateUserCache;
