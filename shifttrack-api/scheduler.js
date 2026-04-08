const cron    = require('node-cron');
const webpush = require('./utils/webpush');
const db      = require('./db/index');

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
        const notifBody = `Your shift at ${shift.name} starts at ${shift.time}`;
        const payload = JSON.stringify({
          title: 'Shift Reminder',
          body:  notifBody,
          icon:  '/shift-track/icon-192.png',
        });
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          );
          // Log to notification history
          await db.query(
            'INSERT INTO notification_log (user_id, title, body) VALUES ($1,$2,$3)',
            [sub.user_id, 'Shift Reminder', notifBody]
          );
          console.log(`[notify] Sent reminder to user ${sub.user_id} for ${shift.name} at ${shift.time}`);
        } catch (e) {
          if (e.statusCode === 410) {
            await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
          } else {
            console.error(`[notify] Push failed for user ${sub.user_id}: ${e.statusCode || e.message}`);
          }
        }
      }
    }
  } catch (err) {
    console.error('[scheduler] Error:', err.message);
  }
});

// Runs every minute — process expired house-type open shifts (assign winner + notify)
cron.schedule('* * * * *', async () => {
  try {
    const expired = await db.query(
      `SELECT os.*, l.name AS location_name
       FROM open_shifts os
       JOIN locations l ON os.location_id = l.id
       WHERE os.status = 'open'
         AND os.target_type = 'house'
         AND os.deadline <= NOW()`
    );
    for (const shift of expired.rows) {
      const claims = await db.query(
        `SELECT c.user_id, u.hire_date, u.name
         FROM open_shift_claims c
         JOIN users u ON c.user_id = u.id
         WHERE c.open_shift_id = $1 AND c.response = 'claimed'
         ORDER BY u.hire_date ASC NULLS LAST, c.responded_at ASC
         LIMIT 1`,
        [shift.id]
      );
      if (claims.rows.length) {
        const winner = claims.rows[0];
        const dateStr = shift.date.toISOString ? shift.date.toISOString().slice(0,10) : String(shift.date).slice(0,10);
        await db.query(
          `INSERT INTO shifts (user_id, location_id, date, start_time, end_time, notes)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [winner.user_id, shift.location_id, shift.date, shift.start_time, shift.end_time, shift.notes || '']
        );
        await db.query(
          `UPDATE open_shifts SET status='claimed', claimed_by=$1 WHERE id=$2`,
          [winner.user_id, shift.id]
        );
        const notifBody = `You got the open shift at ${shift.location_name} on ${dateStr} (${shift.start_time.slice(0,5)}–${shift.end_time.slice(0,5)})`;
        const payload = JSON.stringify({ title: 'Shift Assigned', body: notifBody, icon: '/shift-track/icon-192.png' });
        const subs = await db.query('SELECT * FROM push_subscriptions WHERE user_id=$1', [winner.user_id]);
        for (const sub of subs.rows) {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              payload
            );
          } catch (e) {
            if (e.statusCode === 410)
              await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
            else
              console.error(`[scheduler] Push failed for user ${winner.user_id}: ${e.statusCode || e.message}`);
          }
        }
        await db.query(
          'INSERT INTO notification_log (user_id, title, body) VALUES ($1,$2,$3)',
          [winner.user_id, 'Shift Assigned', notifBody]
        );
        console.log(`[scheduler] House shift ${shift.id} assigned to user ${winner.user_id}`);
      } else {
        await db.query(`UPDATE open_shifts SET status='expired' WHERE id=$1`, [shift.id]);
        console.log(`[scheduler] House shift ${shift.id} expired with no claimers`);
      }
    }
  } catch (err) {
    console.error('[scheduler] Open shift deadline error:', err.message);
  }
});

console.log('[scheduler] Notification cron started (every minute)');
