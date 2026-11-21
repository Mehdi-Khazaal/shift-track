const express   = require('express');
const router    = express.Router();
const db        = require('../db/index');
const auth      = require('../middleware/auth');
const { getUserAnchor, payWeekOf } = require('../utils/ppAnchor');
const { continuesStretch } = require('../utils/reminderRules');
const { logNotification, reminderKey, claimReminder, releaseReminder, pushToSubs } = require('../utils/push');

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
    await db.query('DELETE FROM push_subscriptions WHERE user_id=$1', [req.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications/unsubscribe]', err);
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
  } catch (err) {
    console.error('[notifications/status]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/notifications/history - clear all notifications for the user
router.delete('/history', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM notification_log WHERE user_id=$1', [req.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications/history DELETE]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/notifications/history/:id - delete a single notification
router.delete('/history/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM notification_log WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications/history/:id DELETE]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/notifications/history - last 30 notifications for the logged-in user
router.get('/history', auth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, title, body, sent_at FROM notification_log WHERE user_id=$1 ORDER BY sent_at DESC LIMIT 30',
      [req.userId]
    );
    res.json({ ok: true, notifications: result.rows });
  } catch (err) {
    console.error('[notifications/history GET]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/notifications/broadcast - admin sends push to all/filtered users
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
      usersRes = await db.query('SELECT id FROM users WHERE location_id=$1 AND is_active=TRUE', [filter_value]);
    } else if(filter_type === 'position' && filter_value) {
      usersRes = await db.query('SELECT id FROM users WHERE position=$1 AND is_active=TRUE', [filter_value]);
    } else {
      usersRes = await db.query('SELECT id FROM users WHERE is_active=TRUE');
    }
    const userIds = usersRes.rows.map(u => u.id);
    if(!userIds.length) return res.json({ ok: true, sent: 0, total: 0 });

    // Get push subscriptions for those users
    const subs = await db.query(
      'SELECT * FROM push_subscriptions WHERE user_id = ANY($1)',
      [userIds]
    );

    const payload = JSON.stringify({
      title: notifTitle,
      body,
      icon: '/shift-track/icons/icon-192.png',
      tag: `broadcast-${Date.now()}`,
    });

    // Log for every targeted user first, not just the ones with a device
    // registered — the in-app bell reads notification_log, and logging inside
    // the send loop left anyone without push with nothing to show.
    await Promise.all(userIds.map(id => logNotification(id, notifTitle, body)));

    // Devices that actually accepted the push, not merely the ones attempted.
    const sent = await pushToSubs(subs.rows, payload);

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

    // Only shifts near today can have a reminder due. This used to load the
    // user's entire shift history on every login to find shifts in the next hour.
    const shiftsRes = await db.query(
      `SELECT s.*, l.name as location_name, l.rate
       FROM shifts s JOIN locations l ON s.location_id=l.id
       WHERE s.user_id=$1
         AND s.date BETWEEN CURRENT_DATE - INTERVAL '2 days'
                        AND CURRENT_DATE + INTERVAL '2 days'`, [req.userId]
    );
    const baseRes = await db.query(
      `SELECT b.*, l.name as location_name
       FROM base_schedule b JOIN locations l ON b.location_id=l.id
       WHERE b.user_id=$1`, [req.userId]
    );
    // Cancelled base dates: this path used to ignore them, so it could remind
    // someone about a base shift an admin had cancelled. The cron always checked.
    const suppressedRes = await db.query(
      'SELECT date FROM base_suppressed_dates WHERE user_id=$1', [req.userId]
    );
    const suppressed = new Set(suppressedRes.rows.map(r => String(r.date).slice(0, 10)));
    // Approved leave near today (see utils/reminderRules.js).
    const leaveRes = await db.query(
      `SELECT date FROM leave_requests
       WHERE status='approved' AND user_id=$1
         AND date BETWEEN CURRENT_DATE - INTERVAL '3 days' AND CURRENT_DATE + INTERVAL '2 days'`,
      [req.userId]
    );

    const now = new Date();
    const anchorStr = await getUserAnchor(req.userId);
    let sent = 0;

    // One reminder per stretch: skip a shift that continues one at the same
    // house. Same rule as the cron (utils/reminderRules.js).
    const stretchCtx = {
      logged: shiftsRes.rows, base: baseRes.rows, anchorStr, suppressed,
      leaveDates: new Set(leaveRes.rows.map(r => String(r.date).slice(0, 10))),
    };
    const continues = (dateStr, start, locationId) =>
      continuesStretch({ date: dateStr, start, locationId }, stretchCtx);

    // This endpoint is a catch-up: it exists so that opening the app after a
    // missed cron tick still delivers the reminder. It is NOT an early warning.
    //
    // It used to fire for anything due within the next HOUR, which is why a
    // 30-minute reminder for a 10:00 shift arrived the moment the app was opened
    // at 08:35. A reminder is now only sent once its moment has actually passed,
    // and only if the ledger shows nothing has sent it yet — so the cron and
    // this path can never both deliver the same one.
    const due = new Map();

    for(const sub of subs.rows) {
      const notifyMs = sub.notify_minutes * 60 * 1000;
      const tzOffset = Number(sub.tz_offset || 0);

      const isDue = (dateStr, startTime) => {
        const shiftTime = new Date(`${dateStr}T${startTime}`);
        shiftTime.setMinutes(shiftTime.getMinutes() + tzOffset);
        const notifTime = new Date(shiftTime.getTime() - notifyMs);
        // Past its moment, but the shift itself has not started yet.
        return notifTime <= now && shiftTime > now;
      };

      // Check logged shifts
      shiftsRes.rows.forEach(s => {
        const dateStr = String(s.date).slice(0,10);
        if(isDue(dateStr, s.start_time) && !continues(dateStr, s.start_time, s.location_id)) {
          due.set(reminderKey('logged', s.id, dateStr),
            { name: s.location_name, time: s.start_time.slice(0,5) });
        }
      });

      // Check base schedule shifts in next 14 days
      const localNowMs = now.getTime() - tzOffset * 60 * 1000;
      for(let dayOffset=0; dayOffset<14; dayOffset++) {
        const localD = new Date(localNowMs + dayOffset * 86400000);
        const dayStr = localD.toISOString().slice(0,10);
        // Week 1/2 from the DATE, like the cron. This used to round the current
        // TIME of day, which in the evening could land on the next day's week
        // and remind about the wrong base shift.
        const weekNum = payWeekOf(dayStr, anchorStr);
        const dayOfWeek = localD.getUTCDay();
        if(suppressed.has(dayStr)) continue;

        baseRes.rows.forEach(b => {
          if(Number(b.week) === weekNum && Number(b.day_of_week) === dayOfWeek
             && isDue(dayStr, b.start_time) && !continues(dayStr, b.start_time, b.location_id)) {
            due.set(reminderKey('base', b.id, dayStr),
              { name: b.location_name, time: b.start_time.slice(0,5) });
          }
        });
      }
    }

    for(const [shiftKey, shift] of due) {
      if(!(await claimReminder(req.userId, shiftKey))) continue;   // cron got there first

      const notifBody = `Your shift at ${shift.name} starts at ${shift.time}`;
      const delivered = await pushToSubs(subs.rows, JSON.stringify({
        title: 'Shift Reminder',
        body: notifBody,
        icon: '/shift-track/icons/icon-192.png',
        tag: shiftKey
      }));
      if(!delivered){ await releaseReminder(req.userId, shiftKey); continue; }   // try again next open
      await logNotification(req.userId, 'Shift Reminder', notifBody);
      sent++;
    }
    res.json({ ok: true, sent });
  } catch(err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
