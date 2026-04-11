const db = require('../db/index');

const DEFAULT_ANCHOR = '2026-03-22';

/**
 * Returns the pay-period anchor (YYYY-MM-DD) for a given user.
 * Falls back to DEFAULT_ANCHOR if no settings row exists yet.
 */
async function getUserAnchor(userId) {
  const r = await db.query(
    'SELECT pp_anchor FROM user_settings WHERE user_id=$1',
    [userId]
  );
  return r.rows[0]?.pp_anchor || DEFAULT_ANCHOR;
}

/**
 * Returns 1 or 2 — which pay-period week a given date falls in.
 * @param {string} dateStr   YYYY-MM-DD
 * @param {string} anchorStr YYYY-MM-DD
 */
function payWeekOf(dateStr, anchorStr) {
  const anchor = new Date(anchorStr + 'T00:00:00');
  const d      = new Date(dateStr   + 'T00:00:00');
  const diff   = Math.round((d - anchor) / 86400000);
  return (((diff % 14) + 14) % 14) < 7 ? 1 : 2;
}

module.exports = { getUserAnchor, payWeekOf, DEFAULT_ANCHOR };
