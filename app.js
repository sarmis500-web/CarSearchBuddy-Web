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
      $("inv-list").innerHTML = `<div class="loading">Searching…</div>`; $("inv-more").innerHTML = ""; $("inv-count").textContent = "Searching…";
      CSBData.count(q).then(n => { if (myToken !== invToken) return; $("inv-count").textContent = `${n.toLocaleString()} car${n === 1 ? "" : "s"}${snapGeo ? " within " + invState.radius + " mi" : ""}`; }).catch(() => {});
    } else { $("inv-more").innerHTML = `<div class="loading">Loading…</div>`; }
    try {
      const rows = await CSBData.search(q);
      if (myToken !== invToken) return; // a newer query superseded this one — drop stale results
      if (reset) {
        $("inv-list").innerHTML = "";
        if (!rows.length) { $("inv-list").innerHTML = `<div class="empty">No cars match. ${snapGeo ? "Try a larger distance or " : ""}adjust filters.</div>`; $("inv-count").textContent = "0 cars"; }
      }
      rows.forEach(r => $("inv-list").appendChild(invCard(r, snapGeo)));
      invState.offset += rows.length;
      $("inv-more").innerHTML = "";
      if (rows.length === PAGE) { const b = el("button", "load-more", "Load more"); b.onclick = () => runInventory(false); $("inv-more").appendChild(b); }
    } catch (e) { if (myToken === invToken && reset) $("inv-list").innerHTML = `<div class="empty">Couldn't load cars.<br><small>${e}</small></div>`; }
  }

  function invCard(v, snapGeo = geo) {
    const c = el("div", "card glass");
    const dist = (snapGeo && v.dealer_lat != null) ? Math.round(haversine(snapGeo.lat, snapGeo.lng, v.dealer_lat, v.dealer_lng)) : null;
    const price = v.price > 0 ? `<div class="card-price">${fmt(v.price)}</div>` : `<div class="card-price muted">Call for price</div>`;
    c.innerHTML = `
      <button class="bell ${isFav(v) ? "saved" : ""}">${isFav(v) ? "★" : "☆"}</button>
      <div class="card-top"><div class="card-name">${v.year} ${v.make} ${v.model}${v.trim ? " " + v.trim : ""}</div>${price}</div>
      <div class="chips">
        ${v.condition ? `<span class="tag">${v.condition}</span>` : ""}
        ${v.mileage ? `<span class="tag">${v.mileage.toLocaleString()} mi</span>` : ""}
        ${v.body_style ? `<span class="tag">${v.body_style}</span>` : ""}
        ${v.cylinders ? `<span class="tag">${v.cylinders}-cyl</span>` : ""}
        ${dist != null ? `<span class="tag amber">${dist} mi</span>` : ""}
      </div>
      <div class="card-dealer">${v.dealer_name || ""}${v.dealer_city ? " · " + v.dealer_city + ", " + v.dealer_state : ""}</div>
      <div class="card-actions">
        <button class="btn-sm amber" data-calc>Calculate Payment</button>
        ${v.source_url ? `<a class="btn-sm" href="${v.source_url}" target="_blank" rel="noopener">View listing</a>` : ""}
      </div>`;
    c.querySelector(".bell").onclick = e => { toggleFav(v, "car"); const b = e.currentTarget; const on = isFav(v); b.classList.toggle("saved", on); b.textContent = on ? "★" : "☆"; };
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
    $("lease-count").textContent = `${list.length} lease offer${list.length === 1 ? "" : "s"}` + (leaseState.term !== "adv" ? ` · re-priced to ${leaseState.term} mo` : "");
    const box = $("lease-list"); box.innerHTML = "";
    if (!list.length) { box.innerHTML = `<div class="empty">No lease deals match your filters.</div>`; $("lease-more").innerHTML = ""; return; }
    list.slice(0, leaseState.shown).forEach(o => box.appendChild(leaseCard(o)));
    $("lease-more").innerHTML = "";
    if (list.length > leaseState.shown) { const b = el("button", "load-more", `Load more (${list.length - leaseState.shown})`); b.onclick = () => { leaseState.shown += PAGE; runLeases(); }; $("lease-more").appendChild(b); }
  }

  function nearestDealers(make, n) {
    const ds = dealersByMake[make] || [];
    if (!ds.length) return [];
    if (geo) return ds.map(d => ({ ...d, dist: haversine(geo.lat, geo.lng, d.lat, d.lng) })).sort((a, b) => a.dist - b.dist).slice(0, n);
    return ds.slice(0, n).map(d => ({ ...d, dist: null }));
  }
  function leaseCard(o) {
    const pr = leasePayment(o);
    const c = el("div", "card glass");
    const apr = o.money_factor != null && o.can_recompute ? (o.money_factor * 2400).toFixed(1) + "% APR" : null;
    const eff = (pr.dueAtSigning != null && pr.termMonths) ? Math.round((pr.dueAtSigning + pr.monthly * pr.termMonths) / pr.termMonths) : null;
    const confLabel = LEASE_CONFIDENCE[pr.confidence];
    const ds = nearestDealers(o.make, 4);
    const dchips = ds.length ? `<div class="dealer-chips">${ds.map(d => { let u = d.website || ""; if (u && !/^https?:/.test(u)) u = "https://" + u; return `<a class="dealer-chip" href="${u}" target="_blank" rel="noopener">${d.name}${d.dist != null ? ` <span class="mi">${Math.round(d.dist)} mi</span>` : ""}</a>`; }).join("")}</div>` : "";
    c.innerHTML = `
      <button class="bell ${isFav(o) ? "saved" : ""}">${isFav(o) ? "★" : "☆"}</button>
      <div class="card-top">
        <div class="card-name">${o.year} ${o.make} ${o.model}${o.trim ? " " + o.trim : ""}</div>
        <div class="card-price">${fmt(pr.monthly)}<span style="font-size:13px;color:var(--text-dim)">/mo</span></div>
      </div>
      <div class="chips">
        <span class="tag">${pr.termMonths} mo</span>
        <span class="tag">${fmt(pr.dueAtSigning)} down</span>
        <span class="tag">${(o.annual_mileage / 1000).toFixed(0)}k mi/yr</span>
        ${eff != null ? `<span class="tag">${fmt(eff)}/mo effective</span>` : ""}
        ${apr ? `<span class="tag amber">${apr}</span>` : ""}
        ${o.offer_end_date ? `<span class="tag">ends ${o.offer_end_date}</span>` : ""}
      </div>
      <div class="conf">${pr.confidence === "EXACT" ? "✓ <b>Advertised</b> terms" : "<b>" + confLabel + "</b>"}${o.msrp ? " · MSRP " + fmt(o.msrp) : ""}</div>
      ${dchips}`;
    c.querySelector(".bell").onclick = e => { toggleFav(o, "lease"); const on = isFav(o); e.currentTarget.classList.toggle("saved", on); e.currentTarget.textContent = on ? "★" : "☆"; };
    return c;
  }

  // ===================================================================
  // CALCULATOR
  // ===================================================================
  const calcInputs = { vehiclePrice: 0, downPayment: 0, aprPct: 6.9, termMonths: 72, salesTaxRatePct: 6, docFee: 0, titleLicenseFee: 0, tradeInValue: 0, tradeInPayoff: 0, taxFullPrice: false };
  const CALC_FIELDS = [
    ["vehiclePrice", "Vehicle Price", "$"], ["downPayment", "Down Payment", "$"],
    ["aprPct", "APR %", "%"], ["termMonths", "Term (months)", ""],
    ["salesTaxRatePct", "Sales Tax %", "%"], ["docFee", "Doc Fee", "$"],
    ["titleLicenseFee", "Title / License", "$"], ["tradeInValue", "Trade-in Value", "$"],
    ["tradeInPayoff", "Trade-in Payoff", "$"],
  ];
  function buildCalc() {
    const g = $("calc-grid"); g.innerHTML = "";
    CALC_FIELDS.forEach(([k, label]) => {
      const wrap = el("div", "fgroup");
      wrap.innerHTML = `<label>${label}</label><input inputmode="decimal" data-k="${k}" value="${calcInputs[k] || ""}">`;
      wrap.querySelector("input").addEventListener("input", e => { calcInputs[k] = parseFloat(e.target.value) || 0; recalc(); });
      g.appendChild(wrap);
    });
    const tax = el("div", "fgroup full");
    tax.innerHTML = `<label><input type="checkbox" data-k="taxFullPrice"> Tax full price (CA, VA, HI…) instead of price − trade-in</label>`;
    tax.querySelector("input").addEventListener("change", e => { calcInputs.taxFullPrice = e.target.checked; recalc(); });
    g.appendChild(tax);
    recalc();
  }
  function recalc() {
    const r = computeLoan(calcInputs);
    $("calc-result").innerHTML = r.computable
      ? `<div class="calc-monthly">${fmt(r.monthlyPayment)}<span>/mo</span></div><div class="calc-sub">${calcInputs.termMonths} mo · financing ${fmt(r.amountFinanced)} · tax ${fmt(r.salesTax)}</div>`
      : `<div class="calc-monthly">$0<span>/mo</span></div><div class="calc-sub">Enter a price and term to start</div>`;
  }
  function openCalculatorWith(price) { calcInputs.vehiclePrice = price > 0 ? Math.round(price) : 0; buildCalc(); show("calculator"); toast("Price filled in"); }

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
      if (a === "lease-filter") openSheet("lease");
      if (a === "sheet-back") closeSheet();
      if (a === "sheet-reset") resetSheet();
    });
    $("sheet-apply").onclick = applySheet;
    sheetEl.addEventListener("click", e => { if (e.target === sheetEl) closeSheet(); });
    let invZipT, leaseZipT;
    $("inv-zip").addEventListener("input", e => { clearTimeout(invZipT); const v = e.target.value; invZipT = setTimeout(() => setZip(v, "inv"), 350); });
    $("inv-geo").onclick = useGeolocation;
    $("lease-zip").addEventListener("input", e => { clearTimeout(leaseZipT); const v = e.target.value; leaseZipT = setTimeout(() => setZip(v, "lease"), 350); });
    $("lease-term").addEventListener("click", e => { const s = e.target.closest(".seg"); if (!s) return; $("lease-term").querySelectorAll(".seg").forEach(x => x.classList.remove("active")); s.classList.add("active"); leaseState.term = s.dataset.term; leaseState.shown = PAGE; runLeases(); });
    buildCalc();
  }

  async function boot() {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
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
