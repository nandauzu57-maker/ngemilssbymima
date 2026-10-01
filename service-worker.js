self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let notification = { title: 'Notifikasi Ngemilss', body: 'Ada kabar baru dari tokomu.', url: '/admin' };
  try {
    if (event.data) notification = { ...notification, ...event.data.json() };
  } catch {
    if (event.data) notification.body = event.data.text();
  }
  event.waitUntil(self.registration.showNotification(notification.title, {
    body: notification.body,
    icon: '/brand-logo.png',
    badge: '/brand-logo.png',
    data: { url: notification.url || '/admin' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/admin', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    const existing = clients.find(client => client.url.startsWith(self.location.origin));
    if (existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  }));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then(response => response || new Response('Offline', { status: 503 }))));
});
