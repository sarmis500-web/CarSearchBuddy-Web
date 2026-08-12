/* Microsoft Clarity — free session replay + heatmaps for the Car Lease Buddy PWA.
 *
 * WHY, next to analytics.js: GA4 counts WHAT happened, Clarity shows WHY. Rage clicks,
 * dead clicks, where people stop scrolling, JS errors, and video of the actual session.
 * Free forever, no traffic cap, 90-day recording retention.
 *
 * Ported from WeedBuddy's web/clarity.js (itself ported from ActionBuddy), which has been
 * live and verified since 2026-07-29. Same three constraints, different project id + flag:
 *
 *  1. LAZY — the tag is ~130KB across two files and must never compete with first paint,
 *     so it loads on an idle callback, not inline. Page speed is an SEO ranking signal.
 *
 *  2. ☠️ OUR OWN DEVICES ARE TAGGED, NOT EXCLUDED — Mike's ruling. He wants his own usage
 *     KEPT and separable, not deleted. A device marked internal (analytics.js sets
 *     csb_internal from ?internal=1 and publishes it as window.CSB_INTERNAL) still records,
 *     but the session carries traffic_type=internal so it can be filtered in or out in the
 *     Clarity UI. This matches how GA4 is set up here — mark, never drop.
 *
 *  3. HONOURS DO NOT TRACK — privacy.html promises this in writing: "if your browser sends
 *     that signal we do not load Clarity at all". If you remove this check you are making
 *     the published policy false. Don't.
 *     ⚠️ Note the deliberate asymmetry: GA4 does NOT check DNT, Clarity does. The line is
 *     that Clarity RECORDS the session while GA4 only counts it, and privacy.html states
 *     exactly that. If you change either side, change the page in the same commit.
 *
 * ⛔ DELIBERATELY NOT ON THE 771 STATIC SEO PAGES. Their only job is to rank; 130KB of
 * third-party JS on every one of them trades the growth channel for data we don't need
 * from them. Same call ActionBuddy and WeedBuddy made. GA4 alone goes on those.
 *
 * ⚠️ analytics.js MUST load first — this file reads the internal flag it publishes.
 * ⚠️ Bump ?v= on this file in index.html after ANY edit (sw.js only refreshes index.html).
 *
 * Fail-silent throughout: analytics must never break the app.
 */
(function () {
  'use strict';

  // Clarity project "Car Lease Buddy", created 2026-08-12 (AB = xtx9x8ccmc, WB = xu0mymv2bl).
  // Read out of the project's own tracking snippet, not guessed from the dashboard URL.
  // Blanking this is a complete, instant kill switch for session recording.
  var PROJECT_ID = 'y15ccicuqi';

  if (!/^[a-z0-9]{6,}$/.test(PROJECT_ID)) return;

  try {
    // Do Not Track — privacy.html commits to this. Covers the standard property plus the
    // older vendor-prefixed spellings some browsers still send.
    var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
    if (dnt === '1' || dnt === 'yes') return;
  } catch (e) { /* privacy APIs blocked — fall through and load normally */ }

  function load() {
    try {
      (function (c, l, a, r, i, t, y) {
        c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
        t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
        y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
      })(window, document, 'clarity', 'script', PROJECT_ID);

      // Tag rather than exclude (constraint 2). Clarity's custom tags are filterable in
      // the recordings list, so Mike's own sessions stay findable AND separable.
      if (window.CSB_INTERNAL) window.clarity('set', 'traffic_type', 'internal');
    } catch (e) {}
  }

  if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 6000 });
  else setTimeout(load, 3500);
})();
