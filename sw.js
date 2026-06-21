// Self-healing service worker: clears ALL old caches, removes any previously
// registered (stale) service worker, and reloads open tabs to the fresh app.
// This guarantees devices that cached the OLD PWA at this URL recover to the new build.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.navigate(c.url));
  })());
});
