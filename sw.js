const APP_URL = 'https://mehdi-khazaal.github.io/shift-track/';

self.addEventListener('push', event => {
  // A malformed payload must not take down the handler, or the notification is
  // lost with no trace.
  let data = {};
  try { data = event.data?.json() || {}; } catch (e) { /* fall back to defaults */ }

  // Every notification gets its own tag. They all used to share
  // 'shifttrack-reminder', so a swap request arriving just after a shift
  // reminder silently REPLACED it and the first one was never seen. The server
  // sends a per-reminder tag; anything else falls back to a unique one.
  const tag = data.tag || `shifttrack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  event.waitUntil(
    self.registration.showNotification(data.title || 'ShiftTrack', {
      body: data.body || 'You have an upcoming shift',
      icon: data.icon || '/shift-track/icons/icon-192.png',
      badge: '/shift-track/icons/icon-192.png',
      vibrate: [200, 100, 200],
      tag,
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  // Focus an already-open ShiftTrack window instead of stacking up new ones.
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      for (const w of wins) {
        if (w.url.startsWith(APP_URL) && 'focus' in w) return w.focus();
      }
      return clients.openWindow(APP_URL);
    })
  );
});