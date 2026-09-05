/* Car Lease Buddy — GA4 analytics for the PWA.
 *
 * Ported from the pattern proven in ActionBuddy (firebase/public/app/analytics.js) and
 * WeedBuddy (web/analytics.js), with three deliberate DIFFERENCES, each one a fix for
 * something that made those two hard to read:
 *
 *  1. ⭐ PLAIN gtag.js, NOT the Firebase SDK. AB and WB load Firebase Analytics because
 *     those apps already have a Firebase project for auth/data. CSB has no backend at all,
 *     so pulling in firebase-app-compat + firebase-analytics-compat (~90KB) to send events
 *     would be paying a Firebase tax for nothing. gtag.js is ~28KB and does the same job.
 *
 *  2. ⭐⭐ VIRTUAL page_views ON EVERY SCREEN CHANGE. This is the important one. GA4's
 *     built-in reports — Pages and screens, Landing page, Engagement, and every "views"
 *     metric — are driven by `page_view` events. The PWA is a single-page app: tapping
 *     "Find Lease Deals" swaps a CSS class, the URL never changes, and GA4 therefore
 *     records exactly ONE page_view for an entire session no matter how much the user did.
 *     AB and WB log custom events only, so their standard reports sit empty and the whole
 *     GA4 UI reads as broken. Here `send_page_view` is off and app.js calls
 *     CSBA.pageView(screenId) through show(), which posts a real page_view against a
 *     virtual path (/app/lease-deals, /app/used-cars, …). The standard reports work.
 *
 *  3. ⭐ NO custom event queue. gtag() writes into `window.dataLayer`, which is defined
 *     synchronously below and buffers commands until the real tag loads — so events fired
 *     during the first seconds are kept and replayed in order for free. AB/WB hand-rolled
 *     a queue to solve a problem the platform already solves. The only thing we add is a
 *     cap, so a blocked tag can't grow dataLayer without bound.
 *
 * Kept from AB/WB, deliberately:
 *  - LAZY. The tag loads on an idle callback, never competing with first paint. Page speed
 *    is an SEO ranking signal and this site's growth channel is 771 static pages.
 *  - FAIL-SILENT. Every path is wrapped. Analytics must never be able to break the app.
 *  - INERT UNTIL CONFIGURED. MEASUREMENT_ID starts empty; the regex below fails, and the
 *    whole module does nothing. Deploying it before the GA4 property exists is harmless.
 *
 * ☠️ INTERNAL TRAFFIC — Mike's ruling, carried over from WeedBuddy's clarity.js:
 *    our own devices are TAGGED AND KEPT, NOT EXCLUDED. He wants his usage separable,
 *    not deleted. Open the site once with ?internal=1 to mark this browser; ?internal=0
 *    clears it. Marked hits carry traffic_type=internal.
 *    ⛔ In the GA4 UI the Internal Traffic data filter must stay in **TESTING** state.
 *    Setting it Active does not hide those events, it PERMANENTLY DELETES them. The
 *    reporting scripts exclude them at query time instead (testDataFilterName), which is
 *    reversible. Do not "tidy this up" by activating the filter.
 *
 * ⚠️ localStorage on this origin is SHARED. sarmis500-web.github.io also serves
 *    carsearchbuddy-flyer, LanguageBuddy, cannabis-price-index and others, so
 *    every key here is namespaced csb_*. Do not drop the prefix.
 *
 * ⚠️ Bump ?v= on this file in index.html after ANY edit — sw.js only force-refreshes
 *    index.html, so an unbumped change never reaches a returning visitor.
 */
(function () {
  'use strict';

  // GA4 property "Car Lease Buddy" (account 382171162), web stream "Car Lease Buddy PWA",
  // created 2026-08-12. Empty string is the "not configured yet" sentinel: it fails the
  // regex below, so blanking this is a complete, instant kill switch for GA4 collection.
  var MEASUREMENT_ID = 'G-NSER3NZBZ1';

  var ENABLED = /^G-[A-Z0-9]{6,}$/.test(MEASUREMENT_ID);

  // Virtual paths for the SPA's screens. The keys are the DOM section ids app.js swaps
  // between (see show() in app.js); the values are what GA4's Pages report will show.
  // A screen missing from this map still reports, under its raw id.
  var SCREENS = {
    home:       { path: 'app/home',        title: 'Car Lease Buddy — Home' },
    leases:     { path: 'app/lease-deals', title: 'Car Lease Buddy — Lease Deals' },
    inventory:  { path: 'app/used-cars',   title: 'Car Lease Buddy — Used Car Search' },
    calculator: { path: 'app/calculator',  title: 'Car Lease Buddy — Payment Calculator' },
    saved:      { path: 'app/saved',       title: 'Car Lease Buddy — Saved' }
  };

  var MAX_BUFFER = 60;   // if the tag is blocked, stop growing dataLayer past this

  // --- internal-traffic tagging -------------------------------------------------------
  var isInternal = false;
  try {
    var qs = new URLSearchParams(location.search);
    if (qs.has('internal')) {
      if (qs.get('internal') === '0') localStorage.removeItem('csb_internal');
      else localStorage.setItem('csb_internal', '1');
    }
    isInternal = localStorage.getItem('csb_internal') === '1';
  } catch (e) { /* storage blocked (private mode / embedded browser) — treat as external */ }

  // Exposed so clarity.js can tag its sessions the same way without re-reading storage,
  // and so a quick console check can confirm which side of the line a device is on.
  window.CSB_INTERNAL = isInternal;

  if (!ENABLED) {
    // Still expose the API so app.js can call it unconditionally — every call is a no-op.
    window.CSBA = { log: function () {}, pageView: function () {}, enabled: false };
    return;
  }

  // --- gtag bootstrap -----------------------------------------------------------------
  // dataLayer + the gtag() shim are defined NOW, synchronously. Commands pushed before
  // the remote tag arrives are replayed in order once it does — that is why no custom
  // queue is needed here.
  var loaded = false;
  window.dataLayer = window.dataLayer || [];
  function gtag() {
    try {
      if (!loaded && window.dataLayer.length > MAX_BUFFER) return;  // blocked → stop growing
      window.dataLayer.push(arguments);
    } catch (e) {}
  }

  try {
    gtag('js', new Date());
    // send_page_view:false — we post page_views ourselves, one per screen (see reason 2).
    var cfg = { send_page_view: false };
    // GA4's Internal Traffic data filter keys off this exact parameter name.
    if (isInternal) cfg.traffic_type = 'internal';
    gtag('config', MEASUREMENT_ID, cfg);
    if (isInternal) gtag('set', 'user_properties', { csb_internal: 'true' });
  } catch (e) {}

  function loadTag() {
    if (loaded) return;
    loaded = true;
    try {
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID;
      var f = document.getElementsByTagName('script')[0];
      f.parentNode.insertBefore(s, f);
    } catch (e) {}
  }

  // --- public API ---------------------------------------------------------------------
  // CSBA.log('lease_dealer_click', {make: 'Toyota'})   — a custom event
  // CSBA.pageView('leases')                            — a virtual page_view
  window.CSBA = {
    enabled: true,

    log: function (name, params) {
      try {
        params = params || {};
        if (isInternal) params.traffic_type = 'internal';
        gtag('event', name, params);
      } catch (e) {}
    },

    pageView: function (screenId) {
      try {
        var s = SCREENS[screenId] || { path: 'app/' + screenId, title: 'Car Lease Buddy' };
        // Absolute URL against the site base so GA4 groups these under the real host
        // rather than inventing a path at the origin root (this site lives on a
        // github.io SUBPATH, so document.baseURI matters — don't switch to location.origin).
        var loc;
        try { loc = new URL(s.path, document.baseURI).href; }
        catch (e2) { loc = s.path; }
        var p = { page_location: loc, page_title: s.title, screen_name: screenId };
        if (isInternal) p.traffic_type = 'internal';
        gtag('event', 'page_view', p);
      } catch (e) {}
    }
  };

  // pwa_installed — fires when the browser confirms an install.
  try {
    window.addEventListener('appinstalled', function () { window.CSBA.log('pwa_installed', {}); });
  } catch (e) {}

  // Load the real tag once the app is interactive.
  if ('requestIdleCallback' in window) requestIdleCallback(loadTag, { timeout: 6000 });
  else setTimeout(loadTag, 3500);
})();
