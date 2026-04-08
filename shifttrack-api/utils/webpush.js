const webpush = require('web-push');

webpush.setVapidDetails(
  process.env.WEB_PUSH_CONTACT || 'mailto:admin@shifttrack.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = webpush;
