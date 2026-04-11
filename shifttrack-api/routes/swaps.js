const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');
const webpush = require('../utils/webpush');
const { getUserAnchor, payWeekOf } = require('../utils/ppAnchor');

async function notifyUsers(userIds, title, body) {
  if (!userIds?.length) return;
  const subs = await db.query('SELECT * FROM push_subscriptions WHERE user_id = ANY($1)', [userIds]);
  const payload = JSON.stringify({ title, body, icon: '/shift-track/icon-192.png' });
  const logged = new Set();
  for (const sub of subs.rows) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      if (!logged.has(sub.user_id)) {
        logged.add(sub.user_id);
        await db.query('INSERT INTO notification_log (user_id, title, body) VALUES ($1,$2,$3)',
          [sub.user_id, title, body]);
      }
    } catch (e) {
      if (e.statusCode === 410)
        await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
      else
        console.error(`[swap notify] Push failed for ${sub.user_id}: ${e.statusCode || e.message}`);
    }
  }
}

// Return the Sunday (YYYY-MM-DD) of the week containing dateStr
function sunOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

// Resolve a user's shift on a given date (concrete first, then base schedule).
// anchorStr is that user's personal pay-period anchor (YYYY-MM-DD).
// Returns { shift_id, date, location_id, start_time, end_time, location_name, is_base }
async function resolveShift(userId, dateStr, anchorStr) {
  // 1. Check concrete shifts
  const concrete = await db.query(
    `SELECT s.id, s.date, s.location_id, s.start_time, s.end_time, l.name AS location_name
     FROM shifts s
     JOIN locations l ON s.location_id = l.id
     WHERE s.user_id = $1 AND s.date = $2
     LIMIT 1`,
    [userId, dateStr]
  );
  if (concrete.rows.length) {
    const r = concrete.rows[0];
    return {
      shift_id: r.id,
      date: String(r.date).slice(0, 10),
      location_id: r.location_id,
      start_time: r.start_time,
      end_time: r.end_time,
      location_name: r.location_name,
      is_base: false
    };
  }

  // 2. Check suppressed — if suppressed, no base shift either
  const suppressed = await db.query(
    'SELECT id FROM base_suppressed_dates WHERE user_id=$1 AND date=$2',
    [userId, dateStr]
  );
  if (suppressed.rows.length) return null;

  // 3. Check base schedule using this user's personal anchor
  const dayOfWeek = new Date(dateStr + 'T12:00:00').getDay();
  const weekNum   = payWeekOf(dateStr, anchorStr);
  const base = await db.query(
    `SELECT s.id, s.location_id, s.start_time, s.end_time, l.name AS location_name
     FROM base_schedule s
     JOIN locations l ON s.location_id = l.id
     WHERE s.user_id = $1 AND s.week = $2 AND s.day_of_week = $3
     LIMIT 1`,
    [userId, weekNum, dayOfWeek]
  );
  if (!base.rows.length) return null;
  const b = base.rows[0];
  return {
    shift_id: null,
    date: dateStr,
    location_id: b.location_id,
    start_time: b.start_time,
    end_time: b.end_time,
    location_name: b.location_name,
    is_base: true
  };
}

// ─── POST /api/shift-swaps — initiate a swap request ──────────────────────────
router.post('/', auth, async (req, res) => {
  const { my_date, target_user_id, their_date } = req.body;
  if (!my_date || !target_user_id || !their_date)
    return res.status(400).json({ ok: false, error: 'my_date, target_user_id, their_date are required' });

  if (req.userId === target_user_id)
    return res.status(400).json({ ok: false, error: 'Cannot swap with yourself' });

  if (sunOf(my_date) !== sunOf(their_date))
    return res.status(400).json({ ok: false, error: 'Both shifts must be in the same calendar week' });

  try {
    const targetRes = await db.query('SELECT id, name FROM users WHERE id=$1 AND role=$2 AND is_active=TRUE', [target_user_id, 'user']);
    if (!targetRes.rows.length)
      return res.status(404).json({ ok: false, error: 'Target employee not found' });
    const targetName = targetRes.rows[0].name;

    const [myAnchor, theirAnchor] = await Promise.all([
      getUserAnchor(req.userId),
      getUserAnchor(target_user_id),
    ]);

    const myShift    = await resolveShift(req.userId,     my_date,    myAnchor);
    const theirShift = await resolveShift(target_user_id, their_date, theirAnchor);

    if (!myShift)
      return res.status(404).json({ ok: false, error: 'You have no shift on that date' });
    if (!theirShift)
      return res.status(404).json({ ok: false, error: `${targetName} has no shift on that date` });

    // No duplicate pending swaps
    const dup = await db.query(
      `SELECT id FROM shift_swaps
       WHERE initiator_id=$1 AND initiator_date=$2 AND target_id=$3 AND target_date=$4 AND status='pending'`,
      [req.userId, my_date, target_user_id, their_date]
    );
    if (dup.rows.length)
      return res.status(409).json({ ok: false, error: 'A pending swap request already exists for these shifts' });

    const swap = await db.query(
      `INSERT INTO shift_swaps
         (initiator_id, target_id,
          initiator_shift_id, initiator_date, initiator_location_id, initiator_start, initiator_end,
          target_shift_id,    target_date,    target_location_id,    target_start,    target_end,
          initiator_is_base,  target_is_base)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        req.userId, target_user_id,
        myShift.shift_id,   my_date,    myShift.location_id,    myShift.start_time,    myShift.end_time,
        theirShift.shift_id, their_date, theirShift.location_id, theirShift.start_time, theirShift.end_time,
        myShift.is_base, theirShift.is_base
      ]
    );

    const initiatorRes = await db.query('SELECT name FROM users WHERE id=$1', [req.userId]);
    const initiatorName = initiatorRes.rows[0]?.name || 'Someone';

    await notifyUsers(
      [target_user_id],
      'Shift Swap Request',
      `${initiatorName} wants to swap: their ${myShift.location_name} on ${my_date} ↔ your ${theirShift.location_name} on ${their_date}`
    );

    // Notify admins of new swap proposal
    const admins = await db.query(`SELECT id FROM users WHERE role='admin'`);
    if (admins.rows.length) {
      await notifyUsers(
        admins.rows.map(u => u.id),
        'New Swap Request',
        `${initiatorName} ↔ ${targetName}: ${myShift.location_name} ${my_date} / ${theirShift.location_name} ${their_date}`
      );
    }

    res.json({ ok: true, swap: swap.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ─── GET /api/shift-swaps — all swaps for the logged-in user ──────────────────
router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ss.*,
              u_i.name  AS initiator_name,
              u_t.name  AS target_name,
              l_i.name  AS initiator_location_name, l_i.color AS initiator_location_color,
              l_t.name  AS target_location_name,    l_t.color AS target_location_color
       FROM shift_swaps ss
       JOIN users     u_i ON ss.initiator_id         = u_i.id
       JOIN users     u_t ON ss.target_id            = u_t.id
       JOIN locations l_i ON ss.initiator_location_id = l_i.id
       JOIN locations l_t ON ss.target_location_id    = l_t.id
       WHERE ss.initiator_id = $1 OR ss.target_id = $1
       ORDER BY ss.created_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ ok: true, swaps: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ─── PATCH /api/shift-swaps/:id/respond — accept or reject (target only) ─────
router.patch('/:id/respond', auth, async (req, res) => {
  const { response } = req.body;
  if (!['accepted', 'rejected'].includes(response))
    return res.status(400).json({ ok: false, error: 'response must be accepted or rejected' });

  try {
    const swapRes = await db.query(
      `SELECT ss.*, u_i.name AS initiator_name, u_t.name AS target_name
       FROM shift_swaps ss
       JOIN users u_i ON ss.initiator_id = u_i.id
       JOIN users u_t ON ss.target_id    = u_t.id
       WHERE ss.id = $1`,
      [req.params.id]
    );
    if (!swapRes.rows.length)
      return res.status(404).json({ ok: false, error: 'Swap not found' });
    const swap = swapRes.rows[0];

    if (swap.target_id !== req.userId)
      return res.status(403).json({ ok: false, error: 'Only the target employee can respond' });
    if (swap.status !== 'pending')
      return res.status(409).json({ ok: false, error: 'This swap is no longer pending' });

    if (response === 'rejected') {
      await db.query(`UPDATE shift_swaps SET status='rejected', responded_at=NOW() WHERE id=$1`, [req.params.id]);
      await notifyUsers([swap.initiator_id], 'Swap Request Declined',
        `${swap.target_name} declined your shift swap request`);
      return res.json({ ok: true });
    }

    // === ACCEPT: execute the swap ===
    const iDate = String(swap.initiator_date).slice(0, 10);
    const tDate = String(swap.target_date).slice(0, 10);

    // Suppress base dates or delete concrete shifts
    if (swap.initiator_is_base) {
      await db.query(
        'INSERT INTO base_suppressed_dates (user_id, date) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [swap.initiator_id, iDate]
      );
    } else if (swap.initiator_shift_id) {
      await db.query('DELETE FROM shifts WHERE id=$1', [swap.initiator_shift_id]);
    }

    if (swap.target_is_base) {
      await db.query(
        'INSERT INTO base_suppressed_dates (user_id, date) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [swap.target_id, tDate]
      );
    } else if (swap.target_shift_id) {
      await db.query('DELETE FROM shifts WHERE id=$1', [swap.target_shift_id]);
    }

    // Create swapped shifts and capture their IDs for exact undo later
    // Initiator now works target's slot
    const iSwap = await db.query(
      `INSERT INTO shifts (user_id, location_id, date, start_time, end_time, notes)
       VALUES ($1,$2,$3,$4,$5,'Swapped shift') RETURNING id`,
      [swap.initiator_id, swap.target_location_id, tDate, swap.target_start, swap.target_end]
    );
    // Target now works initiator's slot
    const tSwap = await db.query(
      `INSERT INTO shifts (user_id, location_id, date, start_time, end_time, notes)
       VALUES ($1,$2,$3,$4,$5,'Swapped shift') RETURNING id`,
      [swap.target_id, swap.initiator_location_id, iDate, swap.initiator_start, swap.initiator_end]
    );

    await db.query(
      `UPDATE shift_swaps
       SET status='accepted', responded_at=NOW(),
           swapped_initiator_shift_id=$2, swapped_target_shift_id=$3
       WHERE id=$1`,
      [req.params.id, iSwap.rows[0].id, tSwap.rows[0].id]
    );

    // Notify initiator
    await notifyUsers([swap.initiator_id], 'Swap Accepted!',
      `${swap.target_name} accepted your shift swap`);

    // Notify all admins
    const admins = await db.query(`SELECT id FROM users WHERE role='admin'`);
    if (admins.rows.length) {
      await notifyUsers(admins.rows.map(u => u.id), 'Shift Swap Completed',
        `${swap.initiator_name} ↔ ${swap.target_name}: ${iDate} and ${tDate}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[swap respond]', err);
    res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
});

// ─── DELETE /api/shift-swaps/:id — cancel pending (initiator only) ────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT ss.initiator_id, ss.target_id, ss.status,
              u_i.name AS initiator_name, u_t.name AS target_name,
              ss.initiator_date, ss.target_date
       FROM shift_swaps ss
       JOIN users u_i ON ss.initiator_id = u_i.id
       JOIN users u_t ON ss.target_id    = u_t.id
       WHERE ss.id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'Swap not found' });
    const swap = r.rows[0];
    if (swap.initiator_id !== req.userId)
      return res.status(403).json({ ok: false, error: 'Only the initiator can cancel' });
    if (swap.status !== 'pending')
      return res.status(409).json({ ok: false, error: 'Can only cancel pending swaps' });
    await db.query(`UPDATE shift_swaps SET status='cancelled' WHERE id=$1`, [req.params.id]);
    const iDate = String(swap.initiator_date).slice(0, 10);
    const tDate = String(swap.target_date).slice(0, 10);
    await notifyUsers([swap.target_id], 'Swap Request Cancelled',
      `${swap.initiator_name} cancelled the swap request (${iDate} ↔ ${tDate})`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ─── PATCH /api/shift-swaps/:id/cancel — undo an accepted swap (either party) ─
router.patch('/:id/cancel', auth, async (req, res) => {
  try {
    const swapRes = await db.query(
      `SELECT ss.*, u_i.name AS initiator_name, u_t.name AS target_name
       FROM shift_swaps ss
       JOIN users u_i ON ss.initiator_id = u_i.id
       JOIN users u_t ON ss.target_id    = u_t.id
       WHERE ss.id = $1`,
      [req.params.id]
    );
    if (!swapRes.rows.length)
      return res.status(404).json({ ok: false, error: 'Swap not found' });
    const swap = swapRes.rows[0];

    if (swap.initiator_id !== req.userId && swap.target_id !== req.userId)
      return res.status(403).json({ ok: false, error: 'Not your swap' });
    if (swap.status !== 'accepted')
      return res.status(409).json({ ok: false, error: 'Can only cancel accepted swaps this way' });

    const iDate = String(swap.initiator_date).slice(0, 10);
    const tDate = String(swap.target_date).slice(0, 10);

    // Remove the swapped concrete shifts by their stored IDs (exact, no string matching)
    if (swap.swapped_initiator_shift_id)
      await db.query('DELETE FROM shifts WHERE id=$1', [swap.swapped_initiator_shift_id]);
    if (swap.swapped_target_shift_id)
      await db.query('DELETE FROM shifts WHERE id=$1', [swap.swapped_target_shift_id]);

    // Restore initiator's original slot
    if (swap.initiator_is_base) {
      await db.query('DELETE FROM base_suppressed_dates WHERE user_id=$1 AND date=$2',
        [swap.initiator_id, iDate]);
    } else if (swap.initiator_shift_id) {
      await db.query(
        `INSERT INTO shifts (id, user_id, location_id, date, start_time, end_time, notes)
         VALUES ($1,$2,$3,$4,$5,$6,'') ON CONFLICT DO NOTHING`,
        [swap.initiator_shift_id, swap.initiator_id, swap.initiator_location_id, iDate,
         swap.initiator_start, swap.initiator_end]
      );
    }

    // Restore target's original slot
    if (swap.target_is_base) {
      await db.query('DELETE FROM base_suppressed_dates WHERE user_id=$1 AND date=$2',
        [swap.target_id, tDate]);
    } else if (swap.target_shift_id) {
      await db.query(
        `INSERT INTO shifts (id, user_id, location_id, date, start_time, end_time, notes)
         VALUES ($1,$2,$3,$4,$5,$6,'') ON CONFLICT DO NOTHING`,
        [swap.target_shift_id, swap.target_id, swap.target_location_id, tDate,
         swap.target_start, swap.target_end]
      );
    }

    await db.query(`UPDATE shift_swaps SET status='cancelled', responded_at=NOW() WHERE id=$1`, [req.params.id]);

    // Notify the other party
    const cancellerName = swap.initiator_id === req.userId ? swap.initiator_name : swap.target_name;
    const otherId       = swap.initiator_id === req.userId ? swap.target_id      : swap.initiator_id;
    await notifyUsers([otherId], 'Swap Cancelled',
      `${cancellerName} cancelled the accepted swap (${iDate} ↔ ${tDate}). Your original shift has been restored.`);

    // Notify admins
    const admins = await db.query(`SELECT id FROM users WHERE role='admin'`);
    if (admins.rows.length) {
      await notifyUsers(admins.rows.map(u => u.id), 'Swap Undone by Employee',
        `${cancellerName} cancelled: ${swap.initiator_name} ↔ ${swap.target_name} (${iDate} / ${tDate})`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[swap cancel]', err);
    res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
});

// ─── GET /api/shift-swaps/users — all employees (for picker) ──────────────────
router.get('/users', auth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, name FROM users WHERE role='user' AND is_active=TRUE AND id!=$1 ORDER BY name ASC`,
      [req.userId]
    );
    res.json({ ok: true, users: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
