// CarSearchBuddy — app shell. Inventory comes from R2 via CSBData (db.js); leases
// from bundled leases.json re-priced by engine.js; calculator from computeLoan.
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  // Escape data before innerHTML interpolation. Filter values can arrive from the URL
  // (handleDeepLink), so unescaped chips were a reflected-XSS hole; scraped fields
  // (trim, dealer names) get the same treatment as hardening.
  const escHtml = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmt = n => "$" + Math.round(n).toLocaleString("en-US");
  const PAGE = 25;

  let leases = [], allLeases = [], dealersByMake = {}, zipCoords = {};

  // ---- regional lease pricing (mirrors native Geo.kt METROS / selectForMarket) ----
  // A lease special is a REGIONAL product: the same Tacoma is advertised at $309 in
  // Chicago, $319 in LA and $339 in Detroit, and all three are real. Native used to
  // collapse these with min(payment) — quoting everyone the cheapest market in the
  // country — and the web didn't collapse them at all, so the same car appeared 3-6×.
  const METROS = [
    { region: "48202", label: "Detroit, MI", lat: 42.377, lng: -83.080 },
    { region: "90001", label: "Los Angeles, CA", lat: 33.973, lng: -118.249 },
    { region: "60601", label: "Chicago, IL", lat: 41.886, lng: -87.622 },
    { region: "30301", label: "Atlanta, GA", lat: 33.749, lng: -84.388 },
    { region: "10001", label: "New York, NY", lat: 40.750, lng: -73.997 },
    { region: "80201", label: "Denver, CO", lat: 39.739, lng: -104.985 },
    { region: "98101", label: "Seattle, WA", lat: 47.611, lng: -122.337 },
    { region: "77001", label: "Houston, TX", lat: 29.760, lng: -95.370 },
    { region: "85001", label: "Phoenix, AZ", lat: 33.448, lng: -112.074 },
    { region: "19101", label: "Philadelphia, PA", lat: 39.953, lng: -75.165 },
    { region: "75201", label: "Dallas, TX", lat: 32.781, lng: -96.797 },
    { region: "33101", label: "Miami, FL", lat: 25.779, lng: -80.198 },
  ];
  const metroFor = (lat, lng) => METROS.reduce((best, m) =>
    haversine(lat, lng, m.lat, m.lng) < haversine(lat, lng, best.lat, best.lng) ? m : best, METROS[0]);

  function pickForMarket(vs, mk) {
    const cheapest = () => vs.reduce((a, b) => b.monthly_payment < a.monthly_payment ? b : a);
    if (vs.length === 1 || !mk) return cheapest();
    const own = vs.find(o => o.region === mk.region); if (own) return own;
    const nat = vs.find(o => o.region === "national"); if (nat) return nat;
    const placed = vs.map(o => [o, METROS.find(m => m.region === o.region)]).filter(t => t[1]);
    if (!placed.length) return cheapest();
    return placed.reduce((a, b) =>
      haversine(mk.lat, mk.lng, b[1].lat, b[1].lng) < haversine(mk.lat, mk.lng, a[1].lat, a[1].lng) ? b : a)[0];
  }

  // One offer per car, priced for the user's market. Recomputed whenever geo changes.
  function selectForMarket() {
    const mk = geo ? metroFor(geo.lat, geo.lng) : null;
    const g = new Map();
    for (const o of allLeases) {
      const k = [o.make, o.model, o.trim || "", o.year, o.term_months, o.annual_mileage].join("|");
      (g.get(k) || g.set(k, []).get(k)).push(o);
    }
    leases = [...g.values()].map(v => pickForMarket(v, mk));
    leaseMarket = mk;
  }
  let leaseMarket = null;
  // Shown only when the price is NOT the user's own market (or we don't know theirs).
  const marketNote = o => (o.region === "national" || (leaseMarket && o.region === leaseMarket.region))
    ? "" : ((METROS.find(m => m.region === o.region) || {}).label || "") + " pricing";
  let geo = null; // {lat,lng,label}
  let favorites = JSON.parse(localStorage.getItem("csb_favs") || "[]");

  // ---------- navigation ----------
  function show(id) {
    document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === id));
    window.scrollTo(0, 0);
    if (id === "inventory") runInventory(true);
    if (id === "leases") runLeases();
    if (id === "saved") renderSaved();
  }
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 1800); }

  function haversine(a, b, c, d) {
    const R = 3958.8, tr = Math.PI / 180;
    const dLat = (c - a) * tr, dLng = (d - b) * tr;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * tr) * Math.cos(c * tr) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(x));
  }

  // ---------- location ----------
  function setZip(zip, who) {
    const z = (zip || "").trim();
    if (z.length === 5 && zipCoords[z]) { geo = { lat: zipCoords[z].lat, lng: zipCoords[z].lng, label: "ZIP " + z }; }
    else if (z.length === 0) { geo = null; }
    if (who === "inv") { $("inv-loc-label").textContent = geo ? geo.label : ""; runInventory(true); }
    if (who === "lease") runLeases();
  }
  function useGeolocation() {
    if (!navigator.geolocation) return toast("Location not available");
    toast("Locating…");
    navigator.geolocation.getCurrentPosition(
      p => { geo = { lat: p.coords.latitude, lng: p.coords.longitude, label: "Near you" }; $("inv-loc-label").textContent = geo.label; runInventory(true); },
      () => toast("Couldn't get location"), { enableHighAccuracy: false, timeout: 8000 });
  }

  // The native app asks for location at launch; the web platform only allows a geolocation prompt
  // from a user gesture, so we ask on the user's FIRST tap of a location-relevant home button —
  // Used Cars or Lease Deals. We deliberately do NOT ask on the Payment Calculator (it doesn't use
  // location; a contextless prompt there gets denied, which the browser then remembers permanently).
  // Asked once per session; silent on denial (ZIP entry + the sheet's "Near me" still work).
  let geoAsked = false;
  function maybeAskGeoOnFirstNav(dest) {
    if (geoAsked) return;
    if (dest !== "inventory" && dest !== "leases") return; // only the two location screens count
    geoAsked = true;
    if (geo || !navigator.geolocation) return;             // already located (e.g. ZIP), or unsupported
    // Must run synchronously inside the click gesture — iOS Safari ignores non-gesture requests.
    navigator.geolocation.getCurrentPosition(
      p => {
        geo = { lat: p.coords.latitude, lng: p.coords.longitude, label: "Near you" };
        // Re-run whichever location screen is showing so results sort by the new location.
        const active = document.querySelector(".screen.active");
        if (active && active.id === "inventory") runInventory(true);
        else if (active && active.id === "leases") runLeases();
      },
      () => {},                                             // denial/error: stay silent, keep current behavior
      { enableHighAccuracy: false, timeout: 8000 });
  }

  // ---------- favorites ----------
  const favKey = it => (it.vin || `${it.year}|${it.make}|${it.model}|${it.price}`);
  const isFav = it => favorites.some(f => f.key === favKey(it));
  function toggleFav(it, kind) {
    const k = favKey(it);
    const i = favorites.findIndex(f => f.key === k);
    if (i >= 0) { favorites.splice(i, 1); toast("Removed from saved"); }
    else { favorites.push({ key: k, kind, savedAt: Date.now(), snap: it }); toast("Saved ★"); }
    localStorage.setItem("csb_favs", JSON.stringify(favorites));
  }

  // ===================================================================
  // INVENTORY
  // ===================================================================
  // radius defaults to null = Nationwide (matches native InventoryFilterState's NO_DISTANCE_CAP).
  // A non-null default (e.g. 50) would silently hide cars the moment location is granted — the user
  // opts into a distance via the Distance chip instead. Location just sorts by nearest by default.
  const invState = { filter: {}, sort: "DISTANCE", radius: null, offset: 0, total: null };
  let invToken = 0; // newest-query-wins guard (avoids stale results from rapid re-queries)

  async function runInventory(reset) {
    if (reset) invState.offset = 0;
    const myToken = reset ? ++invToken : invToken;
    const snapGeo = geo; // freeze the location used for this query so labels/distances stay consistent
    const q = { filter: invState.filter, sort: invState.sort, userLat: snapGeo?.lat, userLng: snapGeo?.lng, radiusMiles: invState.radius, limit: PAGE, offset: invState.offset };
    if (reset) {
      renderInvChips();
      // Keep the current results ON SCREEN while a re-query runs (the big one: when location
      // resolves ~1.5s after tap and we re-sort to nearest). Only blank to "Searching…" on a
      // truly empty list (very first load). New rows replace the old ones in place the instant
      // search() returns below, so the user never sees the list vanish — the fix for the
      // "everything disappears then reloads" complaint (we were wiping the list up-front every
      // time, so it flashed even when the re-query itself was fast).
      const keepRows = $("inv-list").firstElementChild && !$("inv-list").firstElementChild.matches(".loading, .empty");
      if (!keepRows) { $("inv-list").innerHTML = `<div class="loading">Searching…</div>`; $("inv-count").textContent = "Searching…"; }
      $("inv-more").innerHTML = "";
      // Native FilterBar label is just "{N} vehicles" (no "within X mi"; distance shows as a chip).
      CSBData.count(q).then(n => { if (myToken !== invToken) return; $("inv-count").textContent = `${n.toLocaleString()} vehicle${n === 1 ? "" : "s"}`; }).catch(() => {});
    } else { $("inv-more").innerHTML = `<div class="loading">Loading…</div>`; }
    try {
      const rows = await CSBData.search(q);
      if (myToken !== invToken) return; // a newer query superseded this one — drop stale results
      if (reset) {
        $("inv-list").innerHTML = "";
        if (!rows.length) { $("inv-list").innerHTML = `<div class="empty">No cars match. ${snapGeo ? "Try a larger distance or " : ""}adjust filters.</div>`; $("inv-count").textContent = "0 vehicles"; }
      }
      rows.forEach(r => $("inv-list").appendChild(invCard(r, snapGeo)));
      invState.offset += rows.length;
      $("inv-more").innerHTML = "";
      if (rows.length === PAGE) { const b = el("button", "load-more", "Load more"); b.onclick = () => runInventory(false); $("inv-more").appendChild(b); }
    } catch (e) { if (myToken === invToken && reset) $("inv-list").innerHTML = `<div class="empty">Couldn't load cars.<br><small>${e}</small></div>`; }
  }

  // Mirrors native InventoryCard (InventoryScreen.kt): title, condition badge, a big amber
  // price paired with a right-aligned Mileage column, the dealer line with "· X mi away"
  // folded in, then two equal-width outlined-amber buttons. No save star (native has none).
  // Active-filter chips under the FilterBar (mirrors native FilterBar's chip row); also
  // toggles the "Clear" button so it only shows when something is actually set.
  function renderInvChips() {
    const f = invState.filter || {};
    const chips = [];
    // Same chip set + order as native FilterBar (InventoryScreen.kt): distance first
    // (with the "needs location" variant), year (incl. "only"), then the rest.
    if (invState.radius) chips.push(geo ? `Within ${invState.radius} mi` : `Within ${invState.radius} mi (needs location)`);
    (f.years || []).slice().sort((a, b) => b - a).forEach(y => chips.push(y === 0 ? "≤2009" : String(y)));
    if (f.maxPrice) chips.push("Under $" + Math.round(f.maxPrice / 1000) + "K");
    if (f.maxMileage) chips.push("Under " + Math.round(f.maxMileage / 1000) + "K mi");
    (f.makes || []).forEach(m => chips.push(m));
    (f.models || []).forEach(m => chips.push(m));
    (f.trims || []).forEach(t => chips.push(t));
    (f.bodyStyles || []).forEach(b => chips.push(b));
    (f.drivetrains || []).forEach(d => chips.push(d));
    (f.cylinders || []).forEach(c => chips.push(c + "-cyl"));
    $("inv-chips").innerHTML = chips.map(c => `<span class="lease-chip">${escHtml(c)}</span>`).join("");
    $("inv-clear").hidden = chips.length === 0;
  }

  function invCard(v, snapGeo = geo) {
    const c = el("div", "card glass uc");
    const dist = (snapGeo && v.dealer_lat != null) ? Math.round(haversine(snapGeo.lat, snapGeo.lng, v.dealer_lat, v.dealer_lng)) : null;
    const price = v.price > 0 ? `<div class="uc-price">${fmt(v.price)}</div>` : `<div class="uc-price muted">Call for price</div>`;
    const mileage = (v.mileage && v.mileage > 0)
      ? `<div class="uc-mileage"><div class="uc-mi-label">Mileage</div><div class="uc-mi-val">${v.mileage.toLocaleString()} mi</div></div>` : "";
    const dealer = `${v.dealer_name || ""}${v.dealer_city ? " — " + v.dealer_city + ", " + v.dealer_state : ""}${dist != null ? " · " + dist + " mi away" : ""}`;
    const dealerBtn = v.source_url
      ? `<a class="uc-btn" href="${v.source_url}" target="_blank" rel="noopener">Dealer Website</a>`
      : `<button class="uc-btn" disabled>Dealer Website</button>`;
    c.innerHTML = `
      <div class="uc-title">${escHtml(`${v.year} ${v.make} ${v.model}${v.trim ? " " + v.trim : ""}`)}</div>
      ${v.condition ? `<div class="uc-cond">${escHtml(v.condition)}</div>` : ""}
      <div class="uc-pricerow">${price}${mileage}</div>
      <div class="uc-dealer">${escHtml(dealer)}</div>
      <div class="uc-actions">
        <button class="uc-btn" data-calc>Payment Calculator</button>
        ${dealerBtn}
      </div>`;
    // Native InventoryCard: tapping the card body opens the dealer website (source_url);
    // the two buttons keep their own actions (calc / website) and must not also trigger it.
    c.querySelector("[data-calc]").onclick = (e) => { e.stopPropagation(); openCalculatorWith(v.price); };
    if (v.source_url) {
      c.style.cursor = "pointer";
      c.addEventListener("click", () => window.open(v.source_url, "_blank", "noopener"));
      const dw = c.querySelector("a.uc-btn"); if (dw) dw.addEventListener("click", (e) => e.stopPropagation());
    }
    return c;
  }

  // ===================================================================
  // LEASES
  // ===================================================================
  // term/mileage/down are re-price inputs (match native LeaseFilterState): null = "as advertised".
  const leaseState = { filter: {}, term: "adv", mileage: null, down: null, shown: PAGE };

  function leasePayment(o) {
    const term = leaseState.term === "adv" ? null : parseInt(leaseState.term, 10);
    return computeLeasePayment(o, { requestedTerm: term, userAnnualMileage: leaseState.mileage, userDownPayment: leaseState.down });
  }
  function filteredLeases() {
    const f = leaseState.filter;
    let list = leases.filter(o => {
      if (f.makes?.length && !f.makes.includes(o.make)) return false;
      if (f.models?.length && !f.models.includes(o.model)) return false;
      if (f.bodies?.length && !f.bodies.includes(o.body_style)) return false;
      const pr = leasePayment(o);
      // A picked term is a real constraint: hide deals the engine can't honestly
      // re-price to it (they used to stay visible at their advertised term, which
      // read as "I asked for 36 and got 24").
      if (leaseState.term !== "adv" && !pr.computable) return false;
      if (f.maxPay && pr.monthly > f.maxPay) return false;
      return true;
    });
    list.sort((a, b) => leasePayment(a).monthly - leasePayment(b).monthly);
    return list;
  }
  function runLeases() {
    selectForMarket();   // geo can arrive/change after load; re-pick the market each render
    const list = filteredLeases();
    // A picked term outside GENERIC_SAFE_TERMS (39/48) shows ONLY deals backed by the
    // lender's own per-term program — re-pricing the rest understated the payment on
    // 177 of 177 measured offers. Say so, or a list dropping from 627 to 198 reads as
    // broken rather than honest. Transcribed from native LeaseScreen.
    const cliffTerm = (leaseState.term !== "adv" && !GENERIC_SAFE_TERMS.has(Number(leaseState.term)))
      ? Number(leaseState.term) : null;
    $("lease-count").textContent = `${list.length} offer${list.length === 1 ? "" : "s"}`
      + (cliffTerm ? ` · only deals with the lender's own ${cliffTerm}-month program` : "");
    renderLeaseChips();
    const box = $("lease-list"); box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = `<div class="empty">${cliffTerm ? `No deals we can price at ${cliffTerm} months` : "No offers match your filters"}</div>`;
      $("lease-more").innerHTML = ""; return;
    }
    list.slice(0, leaseState.shown).forEach(o => box.appendChild(leaseCard(o)));
    $("lease-more").innerHTML = "";
    if (list.length > leaseState.shown) { const b = el("button", "load-more", `Load more (${list.length - leaseState.shown})`); b.onclick = () => { leaseState.shown += PAGE; runLeases(); }; $("lease-more").appendChild(b); }
  }
  // Active-filter chips in the FilterBar (native: makes/models/body styles, horizontal scroll)
  function renderLeaseChips() {
    const f = leaseState.filter, chips = [];
    (f.makes || []).forEach(m => chips.push(m));
    (f.models || []).forEach(m => chips.push(m));
    (f.bodies || []).forEach(b => chips.push(b));
    if (f.maxPay) chips.push(`≤ ${fmt(f.maxPay)}/mo`);
    if (f.maxDown != null) chips.push(`≤ ${fmt(f.maxDown)} down`);
    $("lease-chips").innerHTML = chips.map(c => `<span class="lease-chip">${escHtml(c)}</span>`).join("");
  }

  function nearestDealers(make, n) {
    const ds = dealersByMake[make] || [];
    if (!ds.length) return [];
    if (geo) return ds.map(d => ({ ...d, dist: haversine(geo.lat, geo.lng, d.lat, d.lng) })).sort((a, b) => a.dist - b.dist).slice(0, n);
    return ds.slice(0, n).map(d => ({ ...d, dist: null }));
  }

  // Card layout transcribed from LeaseScreen.kt LeaseOfferCard.
  function leaseCard(o) {
    const pr = leasePayment(o);
    const term = leaseState.term === "adv" ? null : parseInt(leaseState.term, 10);
    const isTermAdj = term != null && term !== o.term_months && pr.computable;
    const isDownAdj = leaseState.down != null && leaseState.down !== o.due_at_signing;
    const isMiAdj = leaseState.mileage != null && leaseState.mileage !== o.annual_mileage;
    const isAdjusted = isTermAdj || isDownAdj || isMiAdj;
    // A non-standard allowance (e.g. Hyundai's 11,250) is a total-mile cap advertised
    // as "22,500 miles total" — spell that out or the odd per-year number reads as a
    // data error. (Mirrors the native advertised-line annotation in LeaseScreen.kt.)
    const annualMi = o.annual_mileage ?? 10000;
    const totalNote = [10000, 12000, 15000].includes(annualMi) ? "" :
      ` (${Math.round(annualMi * o.term_months / 12).toLocaleString()} mi total — low-mileage lease)`;
    // The details row shows the USER's mileage when one is picked (matches native
    // LeaseOfferCard); the offer's own allowance moves to the Advertised line below.
    const shownMi = leaseState.mileage ?? annualMi;
    const mileage = shownMi.toLocaleString() + " mi/yr" + (isMiAdj ? "" : totalNote);
    const mkNote = marketNote(o);
    const mkLine = mkNote ? `<div class="lc-market">${escHtml(mkNote)}</div>` : "";
    const advLine = isAdjusted ?
      `<div class="lc-msrp">Advertised: ${fmt(o.monthly_payment)}/mo with ${fmt(o.due_at_signing)} due${isMiAdj ? ` at ${annualMi.toLocaleString()} mi/yr${totalNote}` : ""}</div>` : "";
    const allDealers = dealersByMake[o.make] || [];
    const dealerCount = allDealers.length;   // national roster (drives the button below)
    const nearest = nearestDealers(o.make, 1)[0];
    const distText = (nearest && nearest.dist != null) ? ` · ${Math.round(nearest.dist)} mi` : "";
    // "+N more": count dealers actually NEAR the user (≤75 mi) when we have a location;
    // with no location this is the whole national roster, so say "nationwide", not "nearby"
    // (was showing e.g. "+593 more nearby" for Toyota's entire US dealer count).
    const nearbyCount = geo ? allDealers.filter(d => haversine(geo.lat, geo.lng, d.lat, d.lng) <= 75).length : dealerCount;
    const moreText = nearbyCount > 1 ? `(+${nearbyCount - 1} more ${geo ? "nearby" : "nationwide"})` : "";
    const c = el("div", "lease-card");
    const trim = o.trim ? " " + o.trim : "";
    c.innerHTML = `
      <div class="lc-name">${o.year} ${o.make} ${o.model}${trim}</div>
      <div class="lc-body">${o.body_style || ""}</div>
      <div class="lc-pay">
        <div class="lc-pay-l">
          <div class="lc-lbl">${isAdjusted ? "Your monthly" : "Monthly"}</div>
          <div class="lc-monthly">${fmt(pr.monthly)}/mo</div>
        </div>
        <div class="lc-pay-r">
          <div class="lc-lbl">${isAdjusted ? "Your down payment" : "Due at signing"}</div>
          <div class="lc-due">${fmt(pr.dueAtSigning)}</div>
        </div>
      </div>
      <div class="lc-details">
        <span class="${isTermAdj ? "adj" : ""}">${pr.termMonths} months</span>
        <span>${mileage}</span>
      </div>
      ${pr.confidence !== "EXACT" ? `<div class="lc-conf">${LEASE_CONFIDENCE[pr.confidence]}</div>` : ""}
      ${mkLine}
      ${advLine}
      ${(o.msrp && o.msrp > 100) ? `<div class="lc-msrp">MSRP: ${fmt(o.msrp)}</div>` : ""}
      ${nearest ? `<div class="lc-dealer">Nearest dealer: ${nearest.name}${distText}</div>${moreText ? `<div class="lc-more">${moreText}</div>` : ""}` : ""}
      <button class="lc-btn">${dealerCount > 0 ? "View Nearby Dealers" : "Dealer Website"}</button>`;
    c.onclick = () => openDealerSheet(o);
    return c;
  }

  // Dealer links popup (native DealerLinksSheet) — homepage links only (never 404).
  function openDealerSheet(o) {
    const hasGeo = !!geo;
    const ds = nearestDealers(o.make, 8);
    const trim = o.trim ? " " + o.trim : "";
    let html = `<div class="dsheet-title">${o.year} ${o.make} ${o.model}${trim}</div>`;
    html += `<div class="dsheet-sub">${hasGeo ? `Nearest ${o.make} dealers` : `${o.make} dealers`} — tap to view inventory</div>`;
    if (!ds.length) {
      html += `<div class="dsheet-sub">No ${o.make} dealers found in our database</div>`;
    } else {
      html += ds.map(d => {
        let u = d.website || ""; if (u && !/^https?:/.test(u)) u = "https://" + u;
        const dist = (hasGeo && d.dist != null) ? ` · <span class="mi">${Math.round(d.dist)} mi</span>` : "";
        return `<a class="dsheet-dealer" href="${u}" target="_blank" rel="noopener">${d.name}${dist}</a>`;
      }).join("");
    }
    $("dsheet-body").innerHTML = html;
    $("dealer-sheet").classList.add("open");
  }
  function closeDealerSheet() { $("dealer-sheet").classList.remove("open"); }

  // ===================================================================
  // CALCULATOR
  // ===================================================================
  const calcInputs = { vehiclePrice: 0, docFee: 0, titleLicenseFee: 0, salesTaxRatePct: 0,
    taxFullPrice: false, tradeInValue: 0, tradeInPayoff: 0, downPayment: 0, aprPct: 0, termMonths: 72 };
  let calcShown = false;
  const CALC_TERMS = [24, 36, 48, 60, 72, 84];
  // Native field order (PaymentCalculatorScreen.kt): price → doc → title → tax rate →
  // [full-price tax checkbox] → trade-in → still-owed → down → APR.
  const CALC_FIELDS = [
    { k: "vehiclePrice",    label: "Vehicle price",          affix: "$", accent: true },
    { k: "docFee",          label: "Doc fee",                affix: "$" },
    { k: "titleLicenseFee", label: "Title & license",        affix: "$" },
    { k: "salesTaxRatePct", label: "Sales tax rate",         affix: "%" },
    { check: true, k: "taxFullPrice", label: "My state taxes the full price (no trade-in credit)" },
    { k: "tradeInValue",    label: "Trade-in value",         affix: "$" },
    { k: "tradeInPayoff",   label: "Still owed on trade-in", affix: "$" },
    { k: "downPayment",     label: "Down payment",           affix: "$" },
    { k: "aprPct",          label: "Interest rate (APR)",    affix: "%" },
  ];

  function buildCalc() {
    const box = $("calc-fields"); box.innerHTML = "";
    CALC_FIELDS.forEach(f => {
      if (f.check) {
        const row = el("div", "calc-check"); const id = "chk_" + f.k;
        row.innerHTML = `<input type="checkbox" id="${id}" ${calcInputs[f.k] ? "checked" : ""}><label for="${id}">${f.label}</label>`;
        row.querySelector("input").addEventListener("change", e => { calcInputs[f.k] = e.target.checked; recalc(); });
        box.appendChild(row); return;
      }
      const pre = f.affix === "$";
      const w = el("div", "mfield " + (pre ? "pre" : "suf") + (f.accent ? " accent" : ""));
      const v = calcInputs[f.k] ? String(calcInputs[f.k]) : "";
      w.innerHTML = `<input inputmode="decimal" placeholder=" " value="${v}"><label>${f.label}</label><span class="affix ${pre ? "pre" : "suf"}">${f.affix}</span>`;
      w.querySelector("input").addEventListener("input", e => { calcInputs[f.k] = parseFloat(e.target.value) || 0; recalc(); });
      box.appendChild(w);
    });
    buildTermChips();
    recalc();
  }
  function buildTermChips() {
    const box = $("calc-terms"); box.innerHTML = "";
    CALC_TERMS.forEach(m => {
      const c = el("div", "term-chip" + (calcInputs.termMonths === m ? " on" : ""), m + " mo");
      c.onclick = () => { calcInputs.termMonths = m; box.querySelectorAll(".term-chip").forEach(x => x.classList.remove("on")); c.classList.add("on"); recalc(); };
      box.appendChild(c);
    });
  }
  function recalc() {
    const r = computeLoan(calcInputs);
    const btn = $("calc-go");
    btn.disabled = !r.computable;
    btn.textContent = r.computable ? "Calculate Payment" : "Enter a vehicle price";
    // Result appears only after Calculate is tapped (or when arriving from a card); then it tracks edits.
    $("calc-result").innerHTML = (calcShown && r.computable) ? resultCard(r) : "";
  }
  function resultCard(r) {
    const i = calcInputs;
    const row = (label, amt, prefix = "", em = false) => `<div class="brow${em ? " em" : ""}"><span>${label}</span><span>${prefix}${fmt(amt)}</span></div>`;
    let rows = row("Vehicle price", i.vehiclePrice);
    if (i.docFee > 0) rows += row("Doc fee", i.docFee);
    if (i.titleLicenseFee > 0) rows += row("Title & license", i.titleLicenseFee);
    if (r.salesTax > 0) rows += row("Sales tax", r.salesTax);
    if (i.tradeInValue > 0) rows += row("Trade-in", i.tradeInValue, "−");
    if (i.tradeInPayoff > 0) rows += row("Owed on trade-in", i.tradeInPayoff, "+");
    if (i.downPayment > 0) rows += row("Down payment", i.downPayment, "−");
    return `<div class="calc-card">
      <div class="lbl">Estimated monthly payment</div>
      <div class="big">${fmt(r.monthlyPayment)}/mo</div>
      <div class="terms">${i.termMonths} months at ${i.aprPct || 0}% APR</div>
      <hr>${rows}<hr class="tight">${row("Amount financed", r.amountFinanced, "", true)}</div>`;
  }
  function openCalculatorWith(price) {
    calcInputs.vehiclePrice = price > 0 ? Math.round(price) : 0;
    calcShown = true; buildCalc(); show("calculator"); toast("Price filled in");
  }

  // ===================================================================
  // SAVED
  // ===================================================================
  function renderSaved() {
    const box = $("saved-list"); box.innerHTML = "";
    if (!favorites.length) { box.innerHTML = `<div class="empty">Nothing saved yet. Tap ☆ on any car or lease to save it here.</div>`; return; }
    favorites.slice().reverse().forEach(f => {
      const it = f.snap; const c = el("div", "card glass");
      c.innerHTML = `<button class="bell saved">★</button>
        <div class="card-name">${it.year} ${it.make} ${it.model}${it.trim ? " " + it.trim : ""}</div>
        <div class="chips"><span class="tag">${f.kind === "lease" ? "Lease deal" : "Used car"}</span>${it.price ? `<span class="tag amber">${fmt(it.price)}</span>` : ""}${it.monthly_payment ? `<span class="tag amber">${fmt(it.monthly_payment)}/mo</span>` : ""}</div>`;
      c.querySelector(".bell").onclick = () => { toggleFav(it, f.kind); renderSaved(); };
      box.appendChild(c);
    });
  }

  // ===================================================================
  // FILTER SHEET (shared)
  // ===================================================================
  // Mainstream car makes only (mirrors InventoryScreen.kt MAINSTREAM_MAKES) — the DB also holds
  // boats/semis/RVs/bikes and junk tokens ("Alcm", "Niss", "Y") nobody is shopping for here.
  const MAINSTREAM_MAKES = new Set(["acura","alfa romeo","aston martin","audi","bentley","bmw","buick","cadillac","chevrolet","chrysler","dodge","ferrari","fiat","fisker","ford","genesis","gmc","honda","hummer","hyundai","infiniti","jaguar","jeep","kia","lamborghini","land rover","lexus","lincoln","lotus","lucid","maserati","mazda","mclaren","mercedes-benz","mercury","mini","mitsubishi","nissan","polestar","pontiac","porsche","ram","rivian","rolls-royce","saab","saturn","scion","subaru","tesla","toyota","volkswagen","volvo"]);

  let sheetCtx = null;       // "inv" | "lease"
  let openMenuKey = null;    // which dropdown-chip menu is open (survives a re-render)
  const sheetEl = $("sheet");
  function openSheet(ctx) { sheetCtx = ctx; openMenuKey = null; buildSheet(); sheetEl.classList.add("open"); }
  function closeSheet() { openMenuKey = null; sheetEl.classList.remove("open"); }
  function setMulti(arr, v, on) { const i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i, 1); }
  function rerunCtx() { if (sheetCtx === "inv") runInventory(true); else runLeases(); }

  // A glass dropdown-chip = native FilterMenuChip. `items`: [{label,on,act}]. single → pick
  // closes + re-renders; multi → toggle keeps the menu open (re-render reopens it).
  function menuChip(grid, key, summary, isSet, items, multi = false) {
    const wrap = el("div", "mchip-wrap"); wrap.dataset.key = key;
    const chip = el("div", "mchip" + (isSet ? " set" : ""));
    chip.innerHTML = `<span class="mchip-sum"></span><span class="mchip-caret">▾</span>`;
    chip.querySelector(".mchip-sum").textContent = summary;
    const menu = el("div", "mmenu"); menu.onclick = e => e.stopPropagation();
    // Options scroll inside their own area; for multi-select an amber "Done" bar is
    // pinned BELOW them so it never scrolls out of reach (matches native).
    const list = el("div", "mmenu-list"); menu.appendChild(list);
    items.forEach(it => {
      const mi = el("div", "mitem" + (it.on ? " on" : "")); mi.textContent = (it.on ? "✓ " : "") + it.label;
      mi.onclick = e => { e.stopPropagation(); it.act(); openMenuKey = multi ? key : null; buildSheet(); };
      list.appendChild(mi);
    });
    if (multi) { const d = el("div", "mitem done", "Done ✓"); d.onclick = e => { e.stopPropagation(); openMenuKey = null; buildSheet(); }; menu.appendChild(d); }
    chip.onclick = e => { e.stopPropagation(); openMenuKey = (openMenuKey === key) ? null : key; placeOpenMenu(); };
    wrap.appendChild(chip); wrap.appendChild(menu); grid.appendChild(wrap);
  }

  // Show the one open menu, positioned (fixed) under its chip so the body's scroll can't clip it.
  function placeOpenMenu() {
    document.querySelectorAll("#sheet .mmenu.open").forEach(m => m.classList.remove("open"));
    document.querySelectorAll("#sheet .mchip.active").forEach(c => c.classList.remove("active"));
    if (!openMenuKey) return;
    const wrap = document.querySelector(`#sheet .mchip-wrap[data-key="${openMenuKey}"]`);
    if (!wrap) return;
    const chip = wrap.querySelector(".mchip"), menu = wrap.querySelector(".mmenu");
    chip.classList.add("active");
    const r = chip.getBoundingClientRect();
    menu.style.left = r.left + "px"; menu.style.width = r.width + "px";
    const below = window.innerHeight - r.bottom;
    if (below > 240 || below >= r.top) { menu.style.top = (r.bottom + 4) + "px"; menu.style.bottom = "auto"; menu.style.maxHeight = Math.min(320, below - 16) + "px"; }
    else { menu.style.bottom = (window.innerHeight - r.top + 4) + "px"; menu.style.top = "auto"; menu.style.maxHeight = Math.min(320, r.top - 16) + "px"; }
    menu.classList.add("open");
  }

  // Location override row (native: 📍 + status + Near me + ZIP), shared by both contexts.
  function buildLocRow() {
    const col = el("div", "loccol");
    const row = el("div", "locrow");
    const label = geo ? (geo.zip ? ("Showing near " + geo.zip) : "Using your location") : "Set a ZIP to sort by distance";
    // White Material "location_on" pin (matches native Icons.Filled.LocationOn, not the 📍 emoji).
    row.innerHTML = `<svg class="pin" viewBox="0 0 24 24" width="18" height="18" fill="#fff" aria-hidden="true"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg><span class="loc-txt"></span>`;
    row.querySelector(".loc-txt").textContent = label;
    const near = el("button", "loc-btn", "Near me");
    near.onclick = e => {
      e.stopPropagation();
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(p => { geo = { lat: p.coords.latitude, lng: p.coords.longitude, label: "Near you" }; rerunCtx(); buildSheet(); });
    };
    row.appendChild(near);
    col.appendChild(row);
    const zip = el("input", "loc-zip"); zip.type = "text"; zip.inputMode = "numeric"; zip.maxLength = 5;
    zip.placeholder = "Enter ZIP (e.g. 78664)"; zip.value = geo?.zip || "";
    zip.onclick = e => e.stopPropagation();
    zip.oninput = () => {
      const v = zip.value.replace(/\D/g, "").slice(0, 5); zip.value = v;
      if (v.length === 5) {
        const c = zipCoords[v];
        if (c) { geo = { lat: c.lat, lng: c.lng, zip: v, label: "ZIP " + v }; rerunCtx(); buildSheet(); }
        else { toast("ZIP " + v + " not recognized"); }  // honest feedback, matches native
      } else if (v.length === 0 && geo) {
        // Deleting the ZIP clears the location (it used to stick until "Start Over").
        // No buildSheet() here — a full re-render would steal focus mid-edit.
        geo = null;
        const txt = document.querySelector("#sheet .loc-txt");
        if (txt) txt.textContent = "Set a ZIP to sort by distance";
        rerunCtx(); updateSheetCount();
      }
    };
    col.appendChild(zip);
    return col;
  }

  let countT, countToken = 0; // newest-count-wins guard (same pattern as runInventory's invToken)
  function updateSheetCount() {
    const btn = $("sheet-apply");
    if (sheetCtx === "lease") { btn.textContent = `Show ${filteredLeases().length} Results`; return; }
    clearTimeout(countT);
    const myToken = ++countToken;
    countT = setTimeout(() => {
      CSBData.count({ filter: invState.filter, userLat: geo?.lat, userLng: geo?.lng, radiusMiles: invState.radius })
        .then(n => { if (myToken !== countToken) return; btn.textContent = `Show ${n.toLocaleString()} Results`; })
        .catch(() => { if (myToken === countToken) btn.textContent = "Show Results"; });
    }, 300);
  }

  async function buildSheet() {
    const body = $("sheet-body"); body.innerHTML = "";
    body.appendChild(buildLocRow());
    body.appendChild(el("div", "fsheet-subrule"));
    const grid = el("div", "mgrid"); body.appendChild(grid);
    // staticFilters() is null until the DB worker's init resolves — opening Filters in
    // the first seconds used to throw. Wait for init (cached after the first call).
    if (!CSBData.staticFilters()) { try { await CSBData.init(); } catch (e) {} }
    const sf = CSBData.staticFilters();
    if (!sf && sheetCtx === "inv") {
      body.appendChild(el("div", "empty", "Filters are still loading — try again in a moment"));
      return;
    }
    if (sheetCtx === "inv") {
      const f = invState.filter; f.makes = f.makes || []; f.models = f.models || []; f.trims = f.trims || []; f.bodyStyles = f.bodyStyles || []; f.cylinders = f.cylinders || [];
      // Multi-select years (mirrors native YEAR_CHOICES + OLDER_YEARS_BUCKET): same
      // tap-to-toggle + sticky Done as Make — picking just 2023 shows only 2023s.
      // 0 in f.years = the "2009 & older" bucket.
      f.years = f.years || [];
      const YEAR_CHOICES = []; for (let y = 2027; y >= 2010; y--) YEAR_CHOICES.push(y);
      const yearSum = !f.years.length ? "Year"
        : (f.years.length === 1 ? (f.years[0] === 0 ? "2009 & older" : String(f.years[0])) : `Year (${f.years.length})`);
      menuChip(grid, "year", yearSum, f.years.length > 0, [
        ...YEAR_CHOICES.map(y => ({ label: String(y), on: f.years.includes(y), act: () => setMulti(f.years, y, !f.years.includes(y)) })),
        { label: "2009 & older", on: f.years.includes(0), act: () => setMulti(f.years, 0, !f.years.includes(0)) },
      ], true);
      const PRICES = [10000, 15000, 20000, 25000, 30000, 40000, 50000, 75000, 100000];
      menuChip(grid, "price", f.maxPrice ? ("Under $" + Math.round(f.maxPrice / 1000) + "K") : "Max Price", !!f.maxPrice,
        [{ label: "No max", on: !f.maxPrice, act: () => f.maxPrice = null }, ...PRICES.map(p => ({ label: "Under $" + (p / 1000) + "K", on: f.maxPrice === p, act: () => f.maxPrice = p }))]);
      const invMakes = sf.makes.filter(mk => MAINSTREAM_MAKES.has(mk.trim().toLowerCase()));
      menuChip(grid, "make", f.makes.length ? ("Make (" + f.makes.length + ")") : "Make", f.makes.length > 0,
        invMakes.map(mk => ({ label: mk, on: f.makes.includes(mk), act: () => { setMulti(f.makes, mk, !f.makes.includes(mk)); f.models = []; f.trims = []; } })), true);
      // Cascading facets (mirrors native): each dropdown offers only the values that
      // exist among the cars every OTHER active filter (incl. distance) narrowed to.
      // Picks are NEVER pruned here just because a sibling filter (price/year/…)
      // emptied them — that silently swapped a picked model for whatever survived.
      // (Parent-scope pruning happens in the chips' act handlers: toggling a make
      // clears models+trims.) Union each faceted list with the current picks so an
      // out-of-facet pick stays visible (checked) and can be un-picked; its honest
      // result count is 0.
      const gLat = geo?.lat, gLng = geo?.lng, gRad = invState.radius;
      const models = [...new Set([...(await CSBData.modelsFacet(f, gLat, gLng, gRad)), ...f.models])].sort();
      const trims = [...new Set([...(await CSBData.trimsFacet(f, gLat, gLng, gRad)), ...f.trims])].sort();
      menuChip(grid, "model", f.models.length ? ("Model (" + f.models.length + ")") : "Model", f.models.length > 0,
        models.length ? models.map(m => ({ label: m, on: f.models.includes(m), act: () => { setMulti(f.models, m, !f.models.includes(m)); f.trims = []; } })) : [{ label: "Pick a make first", on: false, act: () => {} }], models.length > 0);
      menuChip(grid, "trim", f.trims.length ? ("Trim (" + f.trims.length + ")") : "Trim", f.trims.length > 0,
        trims.length ? trims.map(t => ({ label: t, on: f.trims.includes(t), act: () => setMulti(f.trims, t, !f.trims.includes(t)) })) : [{ label: "Pick a make first", on: false, act: () => {} }], trims.length > 0);
      const bodies = [...new Set([...(await CSBData.bodyStylesFacet(f, gLat, gLng, gRad)), ...f.bodyStyles])].sort();
      menuChip(grid, "body", f.bodyStyles.length ? ("Body (" + f.bodyStyles.length + ")") : "Body Style", f.bodyStyles.length > 0,
        bodies.map(b => ({ label: b, on: f.bodyStyles.includes(b), act: () => setMulti(f.bodyStyles, b, !f.bodyStyles.includes(b)) })), true);
      const DIST = [25, 50, 100, 200, 500];
      // The chip reflects the selection even before a location exists (a picked distance
      // that showed no feedback read as "filters aren't wired up"); the hint below the
      // grid explains what it's waiting for — mirrors native's FilterSheet hint.
      menuChip(grid, "dist", invState.radius ? ("Within " + invState.radius + " mi") : "Distance", !!invState.radius,
        [...DIST.map(d => ({ label: "Within " + d + " miles", on: invState.radius === d, act: () => invState.radius = d })), { label: "Nationwide", on: !invState.radius, act: () => invState.radius = null }]);
      const MIL = [30000, 40000, 50000, 60000, 70000, 80000, 90000, 100000];
      menuChip(grid, "mileage", f.maxMileage ? ("Under " + (f.maxMileage / 1000) + "K mi") : "Max Mileage", !!f.maxMileage,
        [{ label: "Any mileage", on: !f.maxMileage, act: () => f.maxMileage = null }, ...MIL.map(m => ({ label: "Under " + (m / 1000) + "K mi", on: f.maxMileage === m, act: () => f.maxMileage = m }))]);
      const cyls = [...new Set([...(await CSBData.cylindersFacet(f, gLat, gLng, gRad)), ...f.cylinders])].sort((a, b) => a - b);
      menuChip(grid, "cyl", f.cylinders.length ? ("Cyl (" + f.cylinders.length + ")") : "Cylinders", f.cylinders.length > 0,
        cyls.map(c => ({ label: c + "-cylinder", on: f.cylinders.includes(c), act: () => setMulti(f.cylinders, c, !f.cylinders.includes(c)) })), true);
      f.drivetrains = f.drivetrains || [];
      const drives = [...new Set([...(await CSBData.drivetrainsFacet(f, gLat, gLng, gRad)), ...f.drivetrains])].sort();
      menuChip(grid, "drive", f.drivetrains.length ? ("Drive (" + f.drivetrains.length + ")") : "Drivetrain", f.drivetrains.length > 0,
        drives.map(d => ({ label: d, on: f.drivetrains.includes(d), act: () => setMulti(f.drivetrains, d, !f.drivetrains.includes(d)) })), true);
      const SORTS = [["DISTANCE", "Nearest"], ["PRICE_LOW", "Price: Low to High"], ["PRICE_HIGH", "Price: High to Low"], ["MILEAGE_LOW", "Lowest Mileage"], ["YEAR_NEW", "Newest Year"], ["MAKE_MODEL", "Make & Model"]];
      menuChip(grid, "sort", (SORTS.find(s => s[0] === invState.sort) || SORTS[0])[1], invState.sort !== "DISTANCE",
        SORTS.map(([v, l]) => ({ label: l, on: invState.sort === v, act: () => invState.sort = v })));
    } else {
      const f = leaseState.filter; f.makes = f.makes || []; f.models = f.models || []; f.bodies = f.bodies || [];
      const lMakes = [...new Set(leases.map(o => o.make))].sort();
      const lBodies = [...new Set(leases.map(o => o.body_style).filter(Boolean))].sort();
      // Must match native LeaseScreen's list EXACTLY (it had drifted: web was
      // 300/400/500/600/800/1000/1500 with no $50 rungs at all). $50 steps through $500
      // then $100s — median advertised payment is $379 and $250/$500 bracket 9%/79% of
      // offers, so 50s are the resolution that separates deals. Above $800 (92% of
      // offers) "No max" takes over, out to the $1,949 top end.
      const PAYS = [200, 250, 300, 350, 400, 450, 500, 600, 700, 800];
      menuChip(grid, "pay", f.maxPay ? ("Under $" + f.maxPay + "/mo") : "Monthly Payment", !!f.maxPay,
        [{ label: "No max", on: !f.maxPay, act: () => f.maxPay = null }, ...PAYS.map(p => ({ label: "Under $" + p + "/mo", on: f.maxPay === p, act: () => f.maxPay = p }))]);
      // Must match native LeaseScreen's list EXACTLY. This control does NOT filter — it
      // RE-PRICES every deal to the chosen down payment, so no rung can come back empty
      // and a smooth ladder beats a sparse one. $500 steps to $4,000 (median advertised
      // due-at-signing $3,999; 70% at or under $4,000), then $1,000 steps.
      const DOWNS = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000];
      menuChip(grid, "down", leaseState.down == null ? "Down Payment" : ("$" + leaseState.down.toLocaleString() + " down"), leaseState.down != null,
        [{ label: "As advertised", on: leaseState.down == null, act: () => leaseState.down = null }, ...DOWNS.map(d => ({ label: "$" + d.toLocaleString() + " down", on: leaseState.down === d, act: () => leaseState.down = d }))]);
      menuChip(grid, "lmake", f.makes.length ? ("Make (" + f.makes.length + ")") : "Make", f.makes.length > 0,
        lMakes.map(mk => ({ label: mk, on: f.makes.includes(mk), act: () => { setMulti(f.makes, mk, !f.makes.includes(mk)); f.models = []; } })), true);
      const lModels = f.makes.length ? [...new Set(leases.filter(o => f.makes.includes(o.make)).map(o => o.model))].sort() : [];
      menuChip(grid, "lmodel", f.models.length ? ("Model (" + f.models.length + ")") : "Model", f.models.length > 0,
        lModels.length ? lModels.map(m => ({ label: m, on: f.models.includes(m), act: () => setMulti(f.models, m, !f.models.includes(m)) })) : [{ label: "Pick a make first", on: false, act: () => {} }], lModels.length > 0);
      const MILES = [10000, 12000, 15000];
      menuChip(grid, "lmiles", leaseState.mileage == null ? "Annual Mileage" : ((leaseState.mileage / 1000) + "K mi/yr"), leaseState.mileage != null,
        [{ label: "As advertised", on: leaseState.mileage == null, act: () => leaseState.mileage = null }, ...MILES.map(m => ({ label: (m / 1000) + "K mi/yr", on: leaseState.mileage === m, act: () => leaseState.mileage = m }))]);
      const TERMS = [["adv", "Advertised"], ["24", "24 months"], ["36", "36 months"], ["39", "39 months"], ["48", "48 months"]];
      menuChip(grid, "lterm", leaseState.term === "adv" ? "Term" : ("Term " + leaseState.term + " mo"), leaseState.term !== "adv",
        TERMS.map(([v, l]) => ({ label: l, on: leaseState.term === v, act: () => leaseState.term = v })));
      menuChip(grid, "lbody", f.bodies.length ? ("Body (" + f.bodies.length + ")") : "Body Style", f.bodies.length > 0,
        lBodies.map(b => ({ label: b, on: f.bodies.includes(b), act: () => setMulti(f.bodies, b, !f.bodies.includes(b)) })), true);
    }
    // Native FilterSheet shows this amber hint whenever a distance is set with no location.
    if (sheetCtx === "inv" && invState.radius && !geo) {
      body.appendChild(el("div", "dist-hint", "Turn on location (or set a ZIP) to filter by distance."));
    }
    placeOpenMenu();
    updateSheetCount();
  }

  function applySheet() {
    closeSheet();
    if (sheetCtx === "inv") { invState.offset = 0; runInventory(true); }
    else { leaseState.shown = PAGE; runLeases(); }
  }
  // One reset behavior everywhere: the sheet's Start Over and the top-bar Start Over
  // both clear the context's filters and return Home.
  function startOver(ctx) {
    if (ctx === "inv") { invState.filter = {}; invState.sort = "DISTANCE"; invState.radius = null; invState.offset = 0; runInventory(true); }
    else { leaseState.filter = {}; leaseState.term = "adv"; leaseState.mileage = null; leaseState.down = null; leaseState.shown = PAGE; runLeases(); }
    show("home");
  }
  function resetSheet() {
    const ctx = sheetCtx;
    closeSheet(); startOver(ctx);
  }

  // ---------- wire up ----------
  function wire() {
    document.body.addEventListener("click", e => {
      const go = e.target.closest("[data-go]"); if (go) { maybeAskGeoOnFirstNav(go.dataset.go); return show(go.dataset.go); }
      const act = e.target.closest("[data-act]"); if (!act) return;
      const a = act.dataset.act;
      if (a === "inv-filter") openSheet("inv");
      if (a === "inv-clear") { invState.filter = {}; invState.sort = "DISTANCE"; invState.radius = null; invState.offset = 0; runInventory(true); }
      if (a === "lease-filter") openSheet("lease");
      if (a === "lease-clear") { leaseState.filter = {}; leaseState.shown = PAGE; runLeases(); }
      if (a === "inv-startover") startOver("inv");
      if (a === "lease-startover") startOver("lease");
      if (a === "sheet-back") closeSheet();
      if (a === "sheet-reset") resetSheet();
    });
    $("sheet-apply").onclick = applySheet;
    // A stray tap (anywhere not a chip/menu, which stopPropagation) closes the open dropdown.
    sheetEl.addEventListener("click", () => { if (openMenuKey) { openMenuKey = null; placeOpenMenu(); } });
    $("sheet-body").addEventListener("scroll", () => { if (openMenuKey) { openMenuKey = null; placeOpenMenu(); } });
    $("dealer-sheet").addEventListener("click", e => { if (e.target === $("dealer-sheet")) closeDealerSheet(); });
    // (ZIP/“Near me” live in the filter sheet now — native has no ZIP row on this screen.)
    $("calc-go").onclick = () => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      calcShown = true; recalc();
      setTimeout(() => { const c = $("calc-result").firstElementChild; if (c) c.scrollIntoView({ behavior: "smooth", block: "end" }); }, 120);
    };
    buildCalc();
  }

  // SEO deep links — the static pages' CTAs (build_seo_pages.py in the native repo)
  // land here as /?screen=used|leases|calc&make=…&model=…&src=seo. make/model may
  // repeat (?model=CAMRY&model=Camry): the DB holds spelling variants of the same
  // model, so the generator passes every variant and we filter on all of them.
  function handleDeepLink() {
    const p = new URLSearchParams(location.search);
    const screen = p.get("screen");
    if (!screen) return;
    const makes = p.getAll("make"), models = p.getAll("model");
    if (screen === "used") {
      if (makes.length) invState.filter.makes = makes;
      if (models.length) invState.filter.models = models;
      show("inventory");
    } else if (screen === "leases") {
      if (makes.length) leaseState.filter.makes = makes;
      if (models.length) leaseState.filter.models = models;
      show("leases");
    } else if (screen === "calc") {
      show("calculator");
    }
    // Clean the URL so a reload/share doesn't re-apply the filter unexpectedly.
    history.replaceState(null, "", location.pathname);
  }

  async function boot() {
    // No service worker for now — kept the app online-only to avoid stale-cache issues.
    // The deployed sw.js is a self-healing kill-switch that clears old caches; we don't re-register.
    wire();
    try {
      // cache:'no-cache' → always revalidate against the server (cheap 304 when
      // unchanged, fresh data the instant a push_web_data deploy changes them), so a
      // returning user never sees stale leases/dealers after a data refresh.
      const nc = { cache: "no-cache" };
      const [lz, ld, ll] = await Promise.all([fetch("zip_coords.json", nc), fetch("dealers.json", nc), fetch("leases.json", nc)]);
      zipCoords = await lz.json();
      dealersByMake = (await ld.json()).dealers_by_make || {};
      allLeases = (await ll.json()).offers || [];
      selectForMarket();
    } catch (e) { console.error("data load", e); }
    handleDeepLink(); // route ?screen=… arrivals from the static SEO pages
    // Warm the DB in the background: init, then pre-run the exact first-paint queries
    // (total count + the no-location first page) so their pages are already in the
    // httpvfs cache when the user taps Used Cars. This MUST use the same sort the first
    // paint actually issues — invState.sort is DISTANCE, which without geo now orders by
    // newest/least-driven; prewarming PRICE_LOW would warm a page we never show.
    CSBData.init()
      .then(() => Promise.all([
        CSBData.count({ filter: {} }),
        CSBData.search({ filter: {}, sort: "DISTANCE", limit: 25, offset: 0 }),
      ]))
      .catch(() => {});
  }
  boot();
})();
