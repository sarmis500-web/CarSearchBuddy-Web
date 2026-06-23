// CarSearchBuddy — app shell. Inventory comes from R2 via CSBData (db.js); leases
// from bundled leases.json re-priced by engine.js; calculator from computeLoan.
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const fmt = n => "$" + Math.round(n).toLocaleString("en-US");
  const PAGE = 25;

  let leases = [], dealersByMake = {}, zipCoords = {};
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
  const invState = { filter: {}, sort: "DISTANCE", radius: 50, offset: 0, total: null };
  let invToken = 0; // newest-query-wins guard (avoids stale results from rapid re-queries)

  async function runInventory(reset) {
    if (reset) invState.offset = 0;
    const myToken = reset ? ++invToken : invToken;
    const snapGeo = geo; // freeze the location used for this query so labels/distances stay consistent
    const q = { filter: invState.filter, sort: invState.sort, userLat: snapGeo?.lat, userLng: snapGeo?.lng, radiusMiles: invState.radius, limit: PAGE, offset: invState.offset };
    if (reset) {
      renderInvChips();
      $("inv-list").innerHTML = `<div class="loading">Searching…</div>`; $("inv-more").innerHTML = ""; $("inv-count").textContent = "Searching…";
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
    if (f.minYear) chips.push(f.minYear + "+");
    if (f.maxPrice) chips.push("Under $" + Math.round(f.maxPrice / 1000) + "K");
    if (f.maxMileage) chips.push("Under " + Math.round(f.maxMileage / 1000) + "K mi");
    (f.makes || []).forEach(m => chips.push(m));
    (f.models || []).forEach(m => chips.push(m));
    (f.bodyStyles || []).forEach(b => chips.push(b));
    (f.cylinders || []).forEach(c => chips.push(c + "-cyl"));
    $("inv-chips").innerHTML = chips.map(c => `<span class="lease-chip">${c}</span>`).join("");
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
      <div class="uc-title">${v.year} ${v.make} ${v.model}${v.trim ? " " + v.trim : ""}</div>
      ${v.condition ? `<div class="uc-cond">${v.condition}</div>` : ""}
      <div class="uc-pricerow">${price}${mileage}</div>
      <div class="uc-dealer">${dealer}</div>
      <div class="uc-actions">
        <button class="uc-btn" data-calc>Payment Calculator</button>
        ${dealerBtn}
      </div>`;
    c.querySelector("[data-calc]").onclick = () => openCalculatorWith(v.price);
    return c;
  }

  // ===================================================================
  // LEASES
  // ===================================================================
  const leaseState = { filter: {}, term: "adv", shown: PAGE };

  function leasePayment(o) {
    const term = leaseState.term === "adv" ? null : parseInt(leaseState.term, 10);
    return computeLeasePayment(o, { requestedTerm: term });
  }
  function filteredLeases() {
    const f = leaseState.filter;
    let list = leases.filter(o => {
      if (f.makes?.length && !f.makes.includes(o.make)) return false;
      if (f.models?.length && !f.models.includes(o.model)) return false;
      if (f.bodies?.length && !f.bodies.includes(o.body_style)) return false;
      const pr = leasePayment(o);
      if (f.maxPay && pr.monthly > f.maxPay) return false;
      if (f.maxDown != null && (pr.dueAtSigning) > f.maxDown) return false;
      return true;
    });
    list.sort((a, b) => leasePayment(a).monthly - leasePayment(b).monthly);
    return list;
  }
  function runLeases() {
    const list = filteredLeases();
    $("lease-count").textContent = `${list.length} offer${list.length === 1 ? "" : "s"}`;
    renderLeaseChips();
    const box = $("lease-list"); box.innerHTML = "";
    if (!list.length) { box.innerHTML = `<div class="empty">No offers match your filters</div>`; $("lease-more").innerHTML = ""; return; }
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
    $("lease-chips").innerHTML = chips.map(c => `<span class="lease-chip">${c}</span>`).join("");
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
    const isAdjusted = isTermAdj;
    const mileage = (o.annual_mileage ?? 10000).toLocaleString();
    const dealerCount = (dealersByMake[o.make] || []).length;
    const nearest = nearestDealers(o.make, 1)[0];
    const distText = (nearest && nearest.dist != null) ? ` · ${Math.round(nearest.dist)} mi` : "";
    const moreText = dealerCount > 1 ? `(+${dealerCount - 1} more nearby)` : "";
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
        <span>${mileage} mi/yr</span>
      </div>
      ${pr.confidence !== "EXACT" ? `<div class="lc-conf">${LEASE_CONFIDENCE[pr.confidence]}</div>` : ""}
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
        const dist = (hasGeo && d.dist != null) ? ` <span class="mi">${Math.round(d.dist)} mi</span>` : "";
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
  let sheetCtx = null; // "inv" | "lease"
  const sheetEl = $("sheet");
  function openSheet(ctx) { sheetCtx = ctx; $("sheet-title").textContent = ctx === "inv" ? "Filter Cars" : "Filter Leases"; buildSheet(); sheetEl.classList.add("open"); }
  function closeSheet() { sheetEl.classList.remove("open"); }

  function chipGroup(label, options, selected, onToggle, full) {
    const g = el("div", "fgroup" + (full ? " full" : ""));
    g.innerHTML = `<label>${label}</label>`;
    const wrap = el("div", "fchips");
    options.forEach(opt => {
      const v = typeof opt === "object" ? opt.value : opt, t = typeof opt === "object" ? opt.label : opt;
      const ch = el("div", "fchip" + (selected.includes(v) ? " on" : ""), t);
      ch.onclick = () => { ch.classList.toggle("on"); onToggle(v, ch.classList.contains("on")); };
      wrap.appendChild(ch);
    });
    g.appendChild(wrap); return g;
  }
  function selectGroup(label, options, value, onChange) {
    const g = el("div", "fgroup");
    g.innerHTML = `<label>${label}</label>`;
    const s = el("select");
    options.forEach(o => { const op = el("option"); op.value = o.value; op.textContent = o.label; if (String(o.value) === String(value)) op.selected = true; s.appendChild(op); });
    s.onchange = e => onChange(e.target.value); g.appendChild(s); return g;
  }

  async function buildSheet() {
    const body = $("sheet-body"); body.innerHTML = "";
    const sf = CSBData.staticFilters();
    if (sheetCtx === "inv") {
      const f = invState.filter; f.makes = f.makes || []; f.models = f.models || []; f.bodyStyles = f.bodyStyles || []; f.cylinders = f.cylinders || [];
      const years = []; for (let y = sf.year_max; y >= sf.year_min; y--) years.push({ value: y, label: y });
      body.appendChild(selectGroup("Min Year", [{ value: 0, label: "Any" }, ...years], f.minYear || 0, v => f.minYear = +v || 0));
      body.appendChild(selectGroup("Max Price", [{ value: 0, label: "Any" }, 10000, 15000, 20000, 25000, 30000, 40000, 50000, 75000].map(v => typeof v === "object" ? v : { value: v, label: fmt(v) }), f.maxPrice || 0, v => f.maxPrice = +v || null));
      body.appendChild(chipGroup("Make", sf.makes, f.makes, async (v, on) => { setMulti(f.makes, v, on); f.models = []; const models = await CSBData.modelsForMakes(f.makes); refreshModels(models, f); }, true));
      const models = await CSBData.modelsForMakes(f.makes);
      const mg = chipGroup("Model", models, f.models, (v, on) => setMulti(f.models, v, on), true); mg.id = "sheet-models"; body.appendChild(mg);
      body.appendChild(chipGroup("Body", sf.body_styles, f.bodyStyles, (v, on) => setMulti(f.bodyStyles, v, on), true));
      body.appendChild(chipGroup("Cylinders", sf.cylinders.map(c => ({ value: c, label: c + "-cyl" })), f.cylinders, (v, on) => setMulti(f.cylinders, +v, on), true));
      body.appendChild(selectGroup("Max Mileage", [{ value: 0, label: "Any" }, 30000, 60000, 90000, 120000, 150000].map(v => typeof v === "object" ? v : { value: v, label: v.toLocaleString() + " mi" }), f.maxMileage || 0, v => f.maxMileage = +v || null));
      body.appendChild(selectGroup("Distance", [25, 50, 100, 250, 500].map(v => ({ value: v, label: v + " mi" })), invState.radius, v => invState.radius = +v));
      body.appendChild(selectGroup("Sort", [["DISTANCE", "Nearest"], ["PRICE_LOW", "Price ↑"], ["PRICE_HIGH", "Price ↓"], ["MILEAGE_LOW", "Lowest miles"], ["YEAR_NEW", "Newest"], ["MAKE_MODEL", "Make/Model"]].map(([v, l]) => ({ value: v, label: l })), invState.sort, v => invState.sort = v));
    } else {
      const f = leaseState.filter; f.makes = f.makes || []; f.models = f.models || []; f.bodies = f.bodies || [];
      const lMakes = [...new Set(leases.map(o => o.make))].sort();
      const lBodies = [...new Set(leases.map(o => o.body_style).filter(Boolean))].sort();
      body.appendChild(chipGroup("Make", lMakes, f.makes, (v, on) => { setMulti(f.makes, v, on); }, true));
      const lModels = f.makes.length ? [...new Set(leases.filter(o => f.makes.includes(o.make)).map(o => o.model))].sort() : [];
      body.appendChild(chipGroup("Model", lModels, f.models, (v, on) => setMulti(f.models, v, on), true));
      body.appendChild(chipGroup("Body", lBodies, f.bodies, (v, on) => setMulti(f.bodies, v, on), true));
      body.appendChild(selectGroup("Max Payment", [{ value: 0, label: "Any" }, 300, 400, 500, 600, 800, 1000].map(v => typeof v === "object" ? v : { value: v, label: fmt(v) + "/mo" }), f.maxPay || 0, v => f.maxPay = +v || null));
      body.appendChild(selectGroup("Max Down", [{ value: -1, label: "Any" }, 0, 1000, 2000, 3000, 5000].map(v => typeof v === "object" ? v : { value: v, label: fmt(v) }), f.maxDown ?? -1, v => f.maxDown = +v < 0 ? null : +v));
    }
  }
  function setMulti(arr, v, on) { const i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i, 1); }
  function refreshModels(models, f) { const old = $("sheet-models"); if (!old) return; const ng = chipGroup("Model", models, f.models, (v, on) => setMulti(f.models, v, on), true); ng.id = "sheet-models"; old.replaceWith(ng); }

  function applySheet() {
    closeSheet();
    if (sheetCtx === "inv") { invState.offset = 0; runInventory(true); }
    else { leaseState.shown = PAGE; runLeases(); }
  }
  function resetSheet() {
    if (sheetCtx === "inv") { invState.filter = {}; invState.sort = "DISTANCE"; invState.radius = 50; }
    else { leaseState.filter = {}; }
    buildSheet();
  }

  // ---------- wire up ----------
  function wire() {
    document.body.addEventListener("click", e => {
      const go = e.target.closest("[data-go]"); if (go) return show(go.dataset.go);
      const act = e.target.closest("[data-act]"); if (!act) return;
      const a = act.dataset.act;
      if (a === "inv-filter") openSheet("inv");
      if (a === "inv-clear") { invState.filter = {}; invState.sort = "DISTANCE"; invState.offset = 0; runInventory(true); }
      if (a === "lease-filter") openSheet("lease");
      if (a === "lease-clear") { leaseState.filter = {}; leaseState.shown = PAGE; runLeases(); }
      if (a === "sheet-back") closeSheet();
      if (a === "sheet-reset") resetSheet();
    });
    $("sheet-apply").onclick = applySheet;
    sheetEl.addEventListener("click", e => { if (e.target === sheetEl) closeSheet(); });
    $("dealer-sheet").addEventListener("click", e => { if (e.target === $("dealer-sheet")) closeDealerSheet(); });
    // (ZIP/“Near me” live in the filter sheet now — native has no ZIP row on this screen.)
    $("calc-go").onclick = () => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      calcShown = true; recalc();
      setTimeout(() => { const c = $("calc-result").firstElementChild; if (c) c.scrollIntoView({ behavior: "smooth", block: "end" }); }, 120);
    };
    buildCalc();
  }

  async function boot() {
    // No service worker for now — kept the app online-only to avoid stale-cache issues.
    // The deployed sw.js is a self-healing kill-switch that clears old caches; we don't re-register.
    wire();
    try {
      const [lz, ld, ll] = await Promise.all([fetch("zip_coords.json"), fetch("dealers.json"), fetch("leases.json")]);
      zipCoords = await lz.json();
      dealersByMake = (await ld.json()).dealers_by_make || {};
      leases = (await ll.json()).offers || [];
    } catch (e) { console.error("data load", e); }
    CSBData.init().catch(() => {}); // warm the DB connection in the background
  }
  boot();
})();
