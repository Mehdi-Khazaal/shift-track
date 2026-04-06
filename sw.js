self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'ShiftTrack', {
      body: data.body || 'You have an upcoming shift',
      icon: data.icon || '/shift-track/icon-192.png',
      badge: '/shift-track/icon-192.png',
      vibrate: [200, 100, 200],
      tag: 'shifttrack-reminder',
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('https://mehdi-khazaal.github.io/shift-track/'));
});