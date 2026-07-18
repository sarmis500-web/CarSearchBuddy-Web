// db.js — CarSearchBuddy web data layer.
// Queries the national inventory SQLite DB hosted on Cloudflare R2 via
// sql.js-httpvfs (HTTP range reads). Ported from the native InventoryRepository.kt.
//
// Backend seam: the rest of the app only calls CSBData.* — today those run the SQL
// in-browser against R2; later they can be swapped to call a Cloudflare Worker
// endpoint (instant single round-trip) without touching the UI.

const CSBData = (() => {
  // Direct R2 object URL. (A caching Worker at csb-db.sarmis500.workers.dev exists in
  // worker/, but its HEAD response doesn't expose Content-Length to mobile browsers, so
  // sql.js-httpvfs full-mode throws "length not known" there — fix that before re-using it.)
  const DB_URL = "https://pub-ec04fb2fbf2d481f8809ef35ba643447.r2.dev/carsearchbuddy.sqlite3";
  // Bump on EVERY data refresh: R2 sends no Cache-Control, so browsers heuristically
  // cache the old DB and show stale data. sql.js-httpvfs appends this as ?cb=… making
  // each refresh a fresh URL. (Value = the OTA data epoch from the push.)
  const DB_CACHE_BUST = "1784401193";
  const NO_PRICE_CAP = 1_000_000, NO_MILEAGE_CAP = 1_000_000;

  const PAGE_COLS =
    "dealer_name,dealer_city,dealer_state,year,make,model,trim,vin,price,condition," +
    "mileage,source_url,body_style,drivetrain,cylinders,fuel_type,dealer_lat,dealer_lng";

  let worker = null;
  let filters = null; // precomputed dropdown lists (filters.json)

  async function init() {
    if (worker) return;
    filters = await fetch("filters.json", { cache: "no-cache" }).then(r => r.json());
    // Resolve to absolute URLs against the document so the worker doesn't re-resolve
    // the wasm path relative to its own location (and so it works under a Pages subpath).
    const workerUrl = new URL("vendor/sqlite.worker.js", location.href).href;
    const wasmUrl = new URL("vendor/sql-wasm.wasm", location.href).href;
    worker = await createDbWorker(
      [{ from: "inline", config: { serverMode: "full", requestChunkSize: 4096, url: DB_URL, cacheBust: DB_CACHE_BUST } }],
      workerUrl,
      wasmUrl
    );
  }

  // Build the WHERE clause + bound args from a filter object (mirrors the native repo).
  function buildWhere(f, userLat, userLng, radiusMiles) {
    const clauses = [], args = [];
    if (f.maxPrice != null && f.maxPrice < NO_PRICE_CAP) { clauses.push("price <= ?"); args.push(f.maxPrice); }
    if (f.minPrice) { clauses.push("price >= ?"); args.push(f.minPrice); }
    if (f.maxMileage != null && f.maxMileage < NO_MILEAGE_CAP) { clauses.push("(mileage IS NULL OR mileage <= ?)"); args.push(f.maxMileage); }
    if (f.years && f.years.length) {
      // Multi-select model years; 0 = the "2009 & older" bucket (mirrors native).
      const exact = f.years.filter(y => y !== 0), parts = [];
      if (exact.length) { parts.push(`year IN (${exact.map(() => "?").join(",")})`); args.push(...exact); }
      if (f.years.includes(0)) parts.push("year < 2010");
      clauses.push("(" + parts.join(" OR ") + ")");
    }
    const inClause = (col, vals) => { clauses.push(`${col} IN (${vals.map(() => "?").join(",")})`); args.push(...vals); };
    if (f.makes && f.makes.length) inClause("make", f.makes);
    if (f.models && f.models.length) inClause("model", f.models);
    if (f.trims && f.trims.length) inClause("trim", f.trims);   // was missing — Trim chip was a silent no-op
    if (f.bodyStyles && f.bodyStyles.length) inClause("body_style", f.bodyStyles);
    if (f.drivetrains && f.drivetrains.length) inClause("drivetrain", f.drivetrains);
    if (f.cylinders && f.cylinders.length) inClause("cylinders", f.cylinders);

    let hasGeo = false;
    if (userLat != null && userLng != null && radiusMiles) {
      const milesPerLngDeg = 69.0 * Math.cos(userLat * Math.PI / 180);
      const latDelta = radiusMiles / 69.0;
      const lngDelta = radiusMiles / milesPerLngDeg;
      clauses.push("dealer_lat BETWEEN ? AND ?"); args.push(userLat - latDelta, userLat + latDelta);
      clauses.push("dealer_lng BETWEEN ? AND ?"); args.push(userLng - lngDelta, userLng + lngDelta);
      // Exact-circle refine (equirectangular miles², arithmetic only) so the box corners
      // beyond the radius are trimmed — mirrors native buildWhere exactly.
      clauses.push("(((dealer_lat - ?) * 69.0) * ((dealer_lat - ?) * 69.0) + ((dealer_lng - ?) * ?) * ((dealer_lng - ?) * ?)) <= ?");
      args.push(userLat, userLat, userLng, milesPerLngDeg, userLng, milesPerLngDeg, radiusMiles * radiusMiles);
      hasGeo = true;
    }
    return { where: clauses.length ? "WHERE " + clauses.join(" AND ") : "", args, hasGeo };
  }

  function orderBy(sort, userLat, userLng, hasGeo) {
    switch (sort) {
      case "DISTANCE":
        if (userLat != null && userLng != null) {
          const mpl = 69.0 * Math.cos(userLat * Math.PI / 180);
          return `ORDER BY (((dealer_lat-${userLat})*69.0)*((dealer_lat-${userLat})*69.0)+` +
                 `((dealer_lng-(${userLng}))*${mpl})*((dealer_lng-(${userLng}))*${mpl})) ASC`;
        }
        return "ORDER BY price ASC";
      case "PRICE_HIGH": return "ORDER BY price DESC";
      case "MILEAGE_LOW": return "ORDER BY mileage IS NULL, mileage ASC";
      case "YEAR_NEW": return "ORDER BY year DESC";
      case "MAKE_MODEL": return "ORDER BY make, model";
      case "PRICE_LOW": default: return "ORDER BY price ASC";
    }
  }

  // FIX for the 14s query: when a geo box is present and we're NOT sorting by distance,
  // SQLite otherwise picks idx_web_price and scatter-scans cheap cars nationwide (~5 MB).
  // Force the geo covering index so it reads only the local box (~1 MB), then sorts.
  function indexHint(hasGeo, sort) {
    return (hasGeo && sort !== "DISTANCE") ? "INDEXED BY idx_web_geo" : "";
  }

  async function search({ filter = {}, sort = "DISTANCE", userLat, userLng, radiusMiles = null, limit = 50, offset = 0 }) {
    await init();
    const { where, args, hasGeo } = buildWhere(filter, userLat, userLng, radiusMiles);
    const hint = indexHint(hasGeo, sort);
    const sql = `SELECT ${PAGE_COLS} FROM vehicles ${hint} ${where} ${orderBy(sort, userLat, userLng, hasGeo)} LIMIT ? OFFSET ?`;
    return worker.db.query(sql, [...args, limit, offset]); // sql.js exec wants params as one array
  }

  async function count({ filter = {}, userLat, userLng, radiusMiles = null }) {
    await init();
    const { where, args, hasGeo } = buildWhere(filter, userLat, userLng, radiusMiles);
    const hint = indexHint(hasGeo, "PRICE_LOW"); // any non-distance hint → force geo index when boxed
    const rows = await worker.db.query(`SELECT COUNT(*) c FROM vehicles ${hint} ${where}`, args);
    return rows[0].c;
  }

  // Dropdowns: makes are precomputed (filters.json); the rest are CASCADING facet
  // queries (mirrors native InventoryRepository) — each list is computed against the
  // current filter with its own dimension cleared, so a dropdown only offers values
  // that exist among the cars the other filters already narrowed to. All four facets
  // require a make (the make-leading covering indexes serve them; an unscoped DISTINCT
  // would scan the whole remote DB over HTTP) — app.js falls back to the static
  // filters.json lists for Body/Cylinders until a make is picked.
  async function makes() { await init(); return filters.makes; }
  async function facetDistinct(col, f, userLat, userLng, radiusMiles) {
    await init();
    const { where, args } = buildWhere(f, userLat, userLng, radiusMiles);
    const guard = `${col} IS NOT NULL AND ${col} <> ''`;
    const rows = await worker.db.query(
      `SELECT DISTINCT ${col} FROM vehicles ${where ? where + " AND " + guard : "WHERE " + guard} ORDER BY ${col}`, args);
    return rows.map(r => r[col]).filter(Boolean);
  }
  async function modelsFacet(f, userLat, userLng, radiusMiles) {
    if (!f.makes || !f.makes.length) return [];
    // Trims are scoped UNDER the model, so a trim pick must not narrow the model list.
    return facetDistinct("model", { ...f, models: [], trims: [] }, userLat, userLng, radiusMiles);
  }
  async function trimsFacet(f, userLat, userLng, radiusMiles) {
    if (!f.makes || !f.makes.length) return [];
    return facetDistinct("trim", { ...f, trims: [] }, userLat, userLng, radiusMiles);
  }
  async function bodyStylesFacet(f, userLat, userLng, radiusMiles) {
    if (!f.makes || !f.makes.length) return filters.body_styles;
    return facetDistinct("body_style", { ...f, bodyStyles: [] }, userLat, userLng, radiusMiles);
  }
  async function drivetrainsFacet(f, userLat, userLng, radiusMiles) {
    if (!f.makes || !f.makes.length) return filters.drivetrains;
    return facetDistinct("drivetrain", { ...f, drivetrains: [] }, userLat, userLng, radiusMiles);
  }
  async function cylindersFacet(f, userLat, userLng, radiusMiles) {
    if (!f.makes || !f.makes.length) return filters.cylinders;
    await init();
    const { where, args } = buildWhere({ ...f, cylinders: [] }, userLat, userLng, radiusMiles);
    const guard = "cylinders IS NOT NULL";
    const rows = await worker.db.query(
      `SELECT DISTINCT cylinders FROM vehicles ${where ? where + " AND " + guard : "WHERE " + guard} ORDER BY cylinders`, args);
    return rows.map(r => r.cylinders).filter(c => c != null);
  }
  function staticFilters() { return filters; } // body_styles, drivetrains, cylinders, year range

  return { init, search, count, makes, modelsFacet, trimsFacet, bodyStylesFacet, drivetrainsFacet, cylindersFacet, staticFilters };
})();

if (typeof window !== "undefined") window.CSBData = CSBData;
