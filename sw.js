/* CarSearchBuddy PWA service worker — "never-stale" freshness only.
 *
 * Its ONLY job is to make sure a returning/reopening user always gets the latest
 * deployed build (GitHub Pages can't set no-cache headers, so we beat the HTTP
 * cache here). It deliberately caches almost nothing — nobody can get stranded on
 * a stale build the way a cache-first SW does.
 *
 * HARD SAFETY RULES (do not weaken — they protect the R2 inventory DB):
 *  - The inventory DB is read from Cloudflare R2 (cross-origin) via sql.js-httpvfs
 *    HTTP RANGE reads, run inside vendor/sqlite.worker.js. Service workers see those
 *    requests too. If we ever respondWith() a range request, Used Cars breaks on the
 *    phone (esp. Safari/iOS). So this SW BAILS OUT immediately on:
 *       (a) any request carrying a `Range` header, and
 *       (b) any cross-origin request.
 *    Those pass straight through to the network, untouched.
 *  - We only ever intercept same-origin NAVIGATIONS (the HTML shell) to force-fresh
 *    them. Everything else (app.js?v=, css, wasm, worker.js, *.json) is left to the
 *    browser; code assets are cache-busted with ?v= in index.html, data JSON is
 *    fetched with cache:'no-cache' by the app.
 * Refs: web.dev/articles/sw-range-requests, philna.sh Safari range-request post.
 */
const SHELL_CACHE = 'csb-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop every old cache (incl. anything left by the old self-destruct SW).
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)));
    // NOTE: deliberately NO clients.claim() — on a genuine update, skipWaiting()
    // already re-claims the clients the previous SW controlled (so updates still
    // auto-reload via controllerchange). Calling claim() here would also fire
    // controllerchange on a user's FIRST-EVER visit and bounce them with a reload.
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // (a) Never touch range requests — this is what keeps the R2 DB range reads working.
  if (req.headers.has('range')) return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // (b) Never touch cross-origin requests (the R2 DB lives on another origin).
  if (url.origin !== self.location.origin) return;

  // Only intercept the APP SHELL navigation — EXACTLY the scope root and its
  // index.html, nothing else. The static SEO pages (/lease-deals/…, /used-cars/…,
  // /explore/) are also same-origin navigations ending in '/', and caching one of
  // them under the 'index.html' key would replace the app shell with an SEO page
  // (the bug that corrupted WeedBuddy's shell twice). Non-shell navigations pass
  // straight through to the network, untouched. Serve the shell with the HTTP
  // cache BYPASSED so a reopened tab can never get a stale build; fall back to
  // the last cached shell only if the network is unreachable.
  const scopePath = new URL(self.registration.scope).pathname; // "/CarSearchBuddy-Web/"
  if (url.pathname === scopePath || url.pathname === scopePath + 'index.html') {
    event.respondWith(
      fetch(req.url, { cache: 'reload' })
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('index.html').then((c) => c || caches.match('./')))
    );
  }
  // Everything else: no respondWith() → the browser handles it normally.
});
