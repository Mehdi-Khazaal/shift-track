const db      = require('../db/index');
const webpush = require('./webpush');

async function logNotification(userId, title, body) {
  try {
    await db.query(
      'INSERT INTO notification_log (user_id, title, body) VALUES ($1,$2,$3)',
      [userId, title, body]
    );
  } catch (e) { /* non-fatal */ }
}

async function notifyUsers(userIds, title, body) {
  if (!userIds?.length) return;

  // The in-app notification bell reads notification_log, so every targeted user
  // gets a row whether or not they ever enabled push. Logging inside the send
  // loop below would skip anyone with no subscription and leave their bell empty.
  await Promise.all(userIds.map(id => logNotification(id, title, body)));

  const subs = await db.query(
    'SELECT * FROM push_subscriptions WHERE user_id = ANY($1)',
    [userIds]
  );
  const payload = JSON.stringify({ title, body, icon: '/shift-track/icons/icon-192.png' });
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
        console.error(`[push] Failed for user ${sub.user_id}: ${e.statusCode || e.message}`);
    }
  }
}

// Stable identity for one shift reminder occurrence, so the cron and
// send-upcoming agree on what "already sent" means.
function reminderKey(kind, id, dateStr) {
  return `${kind}:${id}:${String(dateStr).slice(0, 10)}`;
}

// Claim the right to send a reminder. Returns true only for the first caller —
// the UNIQUE(user_id, shift_key) constraint settles any race between the cron
// and an app opening at the same moment.
async function claimReminder(userId, shiftKey) {
  const r = await db.query(
    `INSERT INTO reminder_sends (user_id, shift_key)
     VALUES ($1, $2)
     ON CONFLICT (user_id, shift_key) DO NOTHING
     RETURNING id`,
    [userId, shiftKey]
  );
  return r.rows.length > 0;
}

// Give a claimed reminder back when no device received it, so the next chance
// (send-upcoming when the app is opened) can try again instead of the ledger
// treating an undelivered reminder as sent.
async function releaseReminder(userId, shiftKey) {
  await db.query('DELETE FROM reminder_sends WHERE user_id=$1 AND shift_key=$2', [userId, shiftKey]);
}

// Push to every device in `subs`, dropping any subscription the push service
// reports as gone. Returns how many devices actually accepted the push.
async function pushToSubs(subs, payload) {
  let delivered = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      delivered++;
    } catch (e) {
      if (e.statusCode === 410)
        await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
      else
        console.error(`[push] Failed for user ${sub.user_id}: ${e.statusCode || e.message}`);
    }
  }
  return delivered;
}

async function sendPushToUser(userId, title, body) {
  await notifyUsers([userId], title, body);
}

async function sendPushToAllAdmins(title, body) {
  const admins = await db.query(
    `SELECT id FROM users WHERE role='admin' AND is_active=TRUE`
  );
  await notifyUsers(admins.rows.map(u => u.id), title, body);
}

module.exports = {
  logNotification, notifyUsers, sendPushToUser, sendPushToAllAdmins,
  reminderKey, claimReminder, releaseReminder, pushToSubs,
};
