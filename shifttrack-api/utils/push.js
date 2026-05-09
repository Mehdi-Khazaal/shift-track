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
  const subs = await db.query(
    'SELECT * FROM push_subscriptions WHERE user_id = ANY($1)',
    [userIds]
  );
  const payload = JSON.stringify({ title, body, icon: '/shift-track/icons/icon-192.png' });
  const logged = new Set();
  for (const sub of subs.rows) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      if (!logged.has(sub.user_id)) {
        logged.add(sub.user_id);
        await logNotification(sub.user_id, title, body);
      }
    } catch (e) {
      if (e.statusCode === 410)
        await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
      else
        console.error(`[push] Failed for user ${sub.user_id}: ${e.statusCode || e.message}`);
    }
  }
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

module.exports = { logNotification, notifyUsers, sendPushToUser, sendPushToAllAdmins };
