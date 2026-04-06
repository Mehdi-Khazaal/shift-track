const cron    = require('node-cron');
const webpush = require('web-push');
const db      = require('./db/index');

webpush.setVapidDetails(
  'mailto:khazaalmahdi1@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const ANCHOR = new Date('2026-03-22T00:00:00Z');

// Runs every minute — sends push notifications when it's time
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    // Send if notifTime fell within the last 60s (matches cron interval, no duplicates)
    const windowBackMs  = 60 * 1000;
    const windowFwdMs   = 5  * 1000; // small forward buffer for cron jitter

    const subsRes = await db.query('SELECT * FROM push_subscriptions');
    if (!subsRes.rows.length) return;

    for (const sub of subsRes.rows) {
      const notifyMs  = Number(sub.notify_minutes) * 60 * 1000;
      // tz_offset from getTimezoneOffset(): positive = behind UTC (e.g. Eastern = 240)
      // local time = UTC - tz_offset minutes  →  UTC = local + tz_offset minutes
      const tzOffset  = Number(sub.tz_offset || 0); // minutes

      const [shiftsRes, baseRes] = await Promise.all([
        db.query(
          `SELECT s.*, l.name as location_name
           FROM shifts s JOIN locations l ON s.location_id = l.id
           WHERE s.user_id = $1`,
          [sub.user_id]
        ),
        db.query(
          `SELECT b.*, l.name as location_name
           FROM base_schedule b JOIN locations l ON b.location_id = l.id
           WHERE b.user_id = $1`,
          [sub.user_id]
        ),
      ]);

      const toSend = [];

      // Logged shifts — date stored as user's local date, time as local time
      for (const s of shiftsRes.rows) {
        const dateStr   = s.date.toISOString().slice(0, 10);
        // Create timestamp treating stored values as local, then convert to UTC
        const shiftTime = new Date(`${dateStr}T${s.start_time}`);
        shiftTime.setMinutes(shiftTime.getMinutes() + tzOffset);
        const notifTime = new Date(shiftTime.getTime() - notifyMs);
        if (notifTime >= now - windowBackMs && notifTime <= now.getTime() + windowFwdMs) {
          toSend.push({ name: s.location_name, time: s.start_time.slice(0, 5) });
        }
      }

      // Base schedule — check next 14 days in user's local time
      const localNowMs = now.getTime() - tzOffset * 60 * 1000;
      for (let offset = 0; offset < 14; offset++) {
        const localD    = new Date(localNowMs + offset * 86400000);
        const dayStr    = localD.toISOString().slice(0, 10); // local date
        const dayOfWeek = localD.getUTCDay();                // local day-of-week
        const diffDays  = Math.round((localD - ANCHOR) / 86400000);
        const inPeriod  = ((diffDays % 14) + 14) % 14;
        const weekNum   = inPeriod < 7 ? 1 : 2;

        for (const b of baseRes.rows) {
          if (Number(b.week) === weekNum && b.day_of_week === dayOfWeek) {
            const shiftTime = new Date(`${dayStr}T${b.start_time}`);
            shiftTime.setMinutes(shiftTime.getMinutes() + tzOffset);
            const notifTime = new Date(shiftTime.getTime() - notifyMs);
            if (notifTime >= now - windowBackMs && notifTime <= now.getTime() + windowFwdMs) {
              toSend.push({ name: b.location_name, time: b.start_time.slice(0, 5) });
            }
          }
        }
      }

      for (const shift of toSend) {
        const payload = JSON.stringify({
          title: 'ShiftTrack — Shift Reminder',
          body:  `${shift.name} starts at ${shift.time}`,
          icon:  '/shift-track/icon-192.png',
        });
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          );
          console.log(`[notify] Sent reminder to user ${sub.user_id} for ${shift.name} at ${shift.time}`);
        } catch (e) {
          if (e.statusCode === 410) {
            await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
          }
        }
      }
    }
  } catch (err) {
    console.error('[scheduler] Error:', err.message);
  }
});

console.log('[scheduler] Notification cron started (every minute)');
