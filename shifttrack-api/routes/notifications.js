const express   = require('express');
const router    = express.Router();
const db        = require('../db/index');
const auth      = require('../middleware/auth');
const webpush   = require('web-push');

webpush.setVapidDetails(
  'mailto:khazaalmahdi1@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Helper: write to notification_log ──────────────────────────────────────
async function logNotification(userId, title, body) {
  try {
    await db.query(
      'INSERT INTO notification_log (user_id, title, body) VALUES ($1,$2,$3)',
      [userId, title, body]
    );
  } catch(e) { /* non-fatal — don't break the push flow */ }
}

// GET /api/notifications/vapid-public-key
router.get('/vapid-public-key', (req, res) => {
  res.json({ ok: true, key: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/notifications/subscribe
router.post('/subscribe', auth, async (req, res) => {
  const { endpoint, keys, notify_minutes, tz_offset } = req.body;
  if(!endpoint || !keys?.p256dh || !keys?.auth)
    return res.status(400).json({ ok: false, error: 'Invalid subscription' });
  try {
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, notify_minutes, tz_offset)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, endpoint) DO UPDATE
       SET p256dh=$3, auth=$4, notify_minutes=$5, tz_offset=$6`,
      [req.userId, endpoint, keys.p256dh, keys.auth, notify_minutes||60, tz_offset??0]
    );
    res.json({ ok: true });
  } catch(err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/notifications/unsubscribe
router.delete('/unsubscribe', auth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM push_subscriptions WHERE user_id=$1',
      [req.userId]
    );
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/notifications/status
router.get('/status', auth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT notify_minutes FROM push_subscriptions WHERE user_id=$1 LIMIT 1',
      [req.userId]
    );
    res.json({ ok: true, subscribed: result.rows.length > 0, notify_minutes: result.rows[0]?.notify_minutes || 60 });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/notifications/history — clear all notifications for the user
router.delete('/history', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM notification_log WHERE user_id=$1', [req.userId]);
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/notifications/history/:id — delete a single notification
router.delete('/history/:id', auth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM notification_log WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/notifications/history — last 30 notifications for the logged-in user
router.get('/history', auth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, title, body, sent_at FROM notification_log WHERE user_id=$1 ORDER BY sent_at DESC LIMIT 30',
      [req.userId]
    );
    res.json({ ok: true, notifications: result.rows });
  } catch(err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/notifications/broadcast — admin sends push to all/filtered users
router.post('/broadcast', auth, async (req, res) => {
  if(req.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin access required' });

  const { title, body, filter_type, filter_value } = req.body;
  if(!body) return res.status(400).json({ ok: false, error: 'Message body required' });
  const notifTitle = (title && title.trim()) ? title.trim() : 'Announcement';

  try {
    // Resolve target user IDs
    let usersRes;
    if(filter_type === 'location' && filter_value) {
      usersRes = await db.query('SELECT id FROM users WHERE location_id=$1', [filter_value]);
    } else if(filter_type === 'position' && filter_value) {
      usersRes = await db.query('SELECT id FROM users WHERE position=$1', [filter_value]);
    } else {
      usersRes = await db.query('SELECT id FROM users');
    }
    const userIds = usersRes.rows.map(u => u.id);
    if(!userIds.length) return res.json({ ok: true, sent: 0, total: 0 });

    // Get push subscriptions for those users
    const subs = await db.query(
      'SELECT * FROM push_subscriptions WHERE user_id = ANY($1)',
      [userIds]
    );

    const payload = JSON.stringify({ title: notifTitle, body, icon: '/shift-track/icon-192.png' });
    let sent = 0;
    const loggedUsers = new Set(); // log once per user regardless of device count

    for(const sub of subs.rows) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
        if(!loggedUsers.has(sub.user_id)){
          loggedUsers.add(sub.user_id);
          await logNotification(sub.user_id, notifTitle, body);
        }
        sent++;
      } catch(e) {
        if(e.statusCode === 410) {
          await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
        }
      }
    }

    res.json({ ok: true, sent, total: userIds.length });
  } catch(err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/notifications/send-upcoming  (called on login to trigger reminders)
router.post('/send-upcoming', auth, async (req, res) => {
  try {
    const subs = await db.query(
      'SELECT * FROM push_subscriptions WHERE user_id=$1', [req.userId]
    );
    if(!subs.rows.length) return res.json({ ok: true, sent: 0 });

    // Get user's shifts + base schedule
    const shiftsRes = await db.query(
      `SELECT s.*, l.name as location_name, l.rate
       FROM shifts s JOIN locations l ON s.location_id=l.id
       WHERE s.user_id=$1`, [req.userId]
    );
    const baseRes = await db.query(
      `SELECT b.*, l.name as location_name
       FROM base_schedule b JOIN locations l ON b.location_id=l.id
       WHERE b.user_id=$1`, [req.userId]
    );

    const now = new Date();
    const anchor = new Date('2026-03-22T00:00:00');
    let sent = 0;
    const logged = new Set(); // deduplicate log entries across multiple devices

    for(const sub of subs.rows) {
      const notifyMs = sub.notify_minutes * 60 * 1000;
      const tzOffset = Number(sub.tz_offset || 0);
      const upcoming = [];

      // Check logged shifts
      shiftsRes.rows.forEach(s => {
        const shiftTime = new Date(`${s.date.toISOString().slice(0,10)}T${s.start_time}`);
        shiftTime.setMinutes(shiftTime.getMinutes() + tzOffset);
        const notifTime = new Date(shiftTime.getTime() - notifyMs);
        if(notifTime > now && notifTime < new Date(now.getTime() + 60*60*1000)) {
          upcoming.push({ name: s.location_name, time: s.start_time.slice(0,5), shiftTime });
        }
      });

      // Check base schedule shifts in next 14 days
      const localNowMs = now.getTime() - tzOffset * 60 * 1000;
      for(let dayOffset=0; dayOffset<14; dayOffset++) {
        const localD = new Date(localNowMs + dayOffset * 86400000);
        const dayStr = localD.toISOString().slice(0,10);
        const diffDays = Math.round((localD - anchor) / 86400000);
        const inPeriod = ((diffDays % 14) + 14) % 14;
        const weekNum = inPeriod < 7 ? 1 : 2;
        const dayOfWeek = localD.getUTCDay();

        baseRes.rows.forEach(b => {
          if(b.week === weekNum && b.day_of_week === dayOfWeek) {
            const shiftTime = new Date(`${dayStr}T${b.start_time}`);
            shiftTime.setMinutes(shiftTime.getMinutes() + tzOffset);
            const notifTime = new Date(shiftTime.getTime() - notifyMs);
            if(notifTime > now && notifTime < new Date(now.getTime() + 60*60*1000)) {
              upcoming.push({ name: b.location_name, time: b.start_time.slice(0,5), shiftTime });
            }
          }
        });
      }

      // Send push for each upcoming shift
      for(const shift of upcoming) {
        const notifBody = `Your shift at ${shift.name} starts at ${shift.time}`;
        const payload = JSON.stringify({
          title: 'Shift Reminder',
          body: notifBody,
          icon: '/shift-track/icon-192.png'
        });
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          );
          // Log once per unique shift body across all subscriptions
          if(!logged.has(notifBody)){
            logged.add(notifBody);
            await logNotification(req.userId, 'Shift Reminder', notifBody);
          }
          sent++;
        } catch(e) {
          if(e.statusCode === 410) {
            await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
          }
        }
      }
    }
    res.json({ ok: true, sent });
  } catch(err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
