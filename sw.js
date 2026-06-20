const CACHE_NAME = 'csb-v3';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './engine.js',
    './db.js',
    './manifest.json',
    './showroom.jpg',
    './apple-touch-icon.png',
    './filters.json',
    './leases.json',
    './dealers.json',
    './zip_coords.json',
    './vendor/httpvfs.js',
    './vendor/sqlite.worker.js',
    './vendor/sql-wasm.wasm'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(() => {})));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Never intercept the R2 database (cross-origin range requests) — let the browser
    // and httpvfs handle those directly, untouched.
    if (url.origin !== location.origin) return;

    if (url.pathname.endsWith('.json')) {
        // Network-first for JSON data so a refresh picks up new leases/dealers.
        event.respondWith(
            fetch(event.request)
                .then(resp => { const c = resp.clone(); caches.open(CACHE_NAME).then(cache => cache.put(event.request, c)); return resp; })
                .catch(() => caches.match(event.request))
        );
    } else {
        // Cache-first for the app shell + wasm (fast, offline-capable loads).
        event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
    }
});
