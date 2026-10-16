/* Face Guard service worker (generated from src/renderer/sw.template.js at build time). */
const VERSION = '__VERSION__';
const ASSETS = __ASSETS__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.method === 'HEAD') {
    // The app HEADs the model files to see if they're bundled; answer from cache when offline.
    event.respondWith(
      caches.match(url.href, { ignoreSearch: true }).then((hit) => (hit ? new Response(null, { status: 200 }) : fetch(req))),
    );
    return;
  }
  if (req.method !== 'GET') return;

  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const client = list[0];
      return client ? client.focus() : self.clients.openWindow('./');
    }),
  );
});
