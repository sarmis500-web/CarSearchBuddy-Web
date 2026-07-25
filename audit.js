#!/usr/bin/env node
/**
 * audit.js — sweep the WHOLE lease surface for defects, in one run.
 *
 *   node audit.js            # audit the local engine.js
 *   node audit.js --live     # audit the DEPLOYED engine.js (what users actually run)
 *
 * Written after a long session of whack-a-mole: every bug found by hand was a case
 * nobody had swept. This exercises the real shipped engine over every offer x every
 * term x every cash-down x every mileage x every market, and asserts properties that
 * MUST hold rather than eyeballing a few cards.
 *
 * Each check states what would make it FAIL, so a check that cannot fail is visible
 * as such. A check that passes vacuously (0 cases examined) is reported as SKIPPED,
 * never as a pass.
 */
const fs = require("fs");
const path = require("path");

const LEASES = path.join(__dirname,
  "../CarSearchBuddy/composeApp/src/commonMain/composeResources/files/leases.json");
const METROS = [
  ["48202", "Detroit, MI"], ["90001", "Los Angeles, CA"], ["60601", "Chicago, IL"],
  ["30301", "Atlanta, GA"], ["10001", "New York, NY"], ["80201", "Denver, CO"],
  ["98101", "Seattle, WA"], ["77001", "Houston, TX"], ["85001", "Phoenix, AZ"],
  ["19101", "Philadelphia, PA"], ["75201", "Dallas, TX"], ["33101", "Miami, FL"],
];
const DOWNS = [0, 500, 1000, 2000, 3000, 4000, 5000, 7500, 10000];
const MILES = [10000, 12000, 15000, 20000];
const TERMS = [13, 24, 36, 39, 48];

const results = [];
function check(name, fails_when, fn) {
  let n = 0, bad = [];
  try { ({ n, bad } = fn()); } catch (e) { bad = [`THREW: ${e.message}`]; n = 1; }
  const status = n === 0 ? "SKIP" : bad.length ? "FAIL" : "PASS";
  results.push({ name, status, n, bad, fails_when });
}

// ── load the engine under test ────────────────────────────────────────────────
const live = process.argv.includes("--live");
const engineSrc = live
  ? require("child_process").execSync(
      "curl -s --max-time 20 https://sarmis500-web.github.io/CarSearchBuddy-Web/engine.js").toString()
  : fs.readFileSync(path.join(__dirname, "engine.js"), "utf8");
eval(engineSrc);
const offers = JSON.parse(fs.readFileSync(LEASES, "utf8")).offers;
const pay = (o, opts) => computeLeasePayment(o, opts || {});
const pricedFor = (o, r) =>
  o.region === "national" || o.region === r || (o.regions || []).includes(r);

console.log(`auditing ${live ? "LIVE (deployed)" : "LOCAL"} engine · ${offers.length} offers\n`);

// ── A. the advertised deal must never move ────────────────────────────────────
check("advertised payment is reproduced exactly",
  "any offer's untouched payment differs from the manufacturer's ad by >$2", () => {
  const bad = [];
  for (const o of offers) {
    const r = pay(o);
    if (!r.computable || Math.abs(r.monthly - o.monthly_payment) > 2)
      bad.push(`${o.make} ${o.model} ad $${o.monthly_payment} -> $${r.monthly.toFixed(2)}`);
  }
  return { n: offers.length, bad };
});

// ── B. a term the maker never advertised must be refused ──────────────────────
check("no payment is computed for an unadvertised term",
  "any requested term != the advertised term returns computable:true", () => {
  const bad = []; let n = 0;
  for (const o of offers) for (const t of TERMS) {
    if (t === o.term_months) continue;
    n++;
    if (pay(o, { requestedTerm: t }).computable)
      bad.push(`${o.make} ${o.model} ${o.term_months}mo -> ${t}mo was computable`);
  }
  return { n, bad };
});

// ── C/D. cash down: monotonic, and never cheaper than the ad ──────────────────
check("more cash down always lowers the payment",
  "a SHOWN payment rises when the customer puts MORE money down", () => {
  // A refusal is NOT a failure: enough cash down makes the lease degenerate (financed
  // cap <= residual) and the engine correctly declines rather than contradicting the
  // user. Only a payment that is actually DISPLAYED and moves the wrong way is a bug.
  // Refusals are reported below as information so they can never hide silently.
  const bad = []; let n = 0; const refusedAt = {};
  for (const o of offers) {
    let prev = null;
    for (const d of DOWNS) {
      const r = pay(o, { userDownPayment: d });
      if (!r.computable) { refusedAt[d] = (refusedAt[d] || 0) + 1; continue; }
      n++;
      if (prev !== null && r.monthly > prev + 0.01)
        bad.push(`${o.make} ${o.model}: $${d} down costs MORE ($${r.monthly.toFixed(2)} > $${prev.toFixed(2)})`);
      prev = r.monthly;
    }
  }
  const refused = Object.entries(refusedAt).filter(([, c]) => c)
    .map(([d, c]) => `$${Number(d).toLocaleString()}:${c}`).join("  ");
  console.log(`        (refused as degenerate, row hidden — ${refused || "none"})`);
  return { n, bad };
});

check("paying LESS than advertised never yields a cheaper payment",
  "a deal quotes below its advertised payment when less cash is put down", () => {
  const bad = []; let n = 0;
  for (const o of offers) for (const d of DOWNS) {
    if (d > o.due_at_signing) continue;
    n++;
    const r = pay(o, { userDownPayment: d });
    if (r.computable && r.monthly < o.monthly_payment - 0.01)
      bad.push(`${o.make} ${o.model} $${d} down -> $${r.monthly.toFixed(2)} < ad $${o.monthly_payment}`);
  }
  return { n, bad };
});

// ── E/F. mileage: monotonic, never cheaper than the ad ────────────────────────
check("more miles always raises the payment",
  "asking for MORE miles produces a cheaper payment", () => {
  const bad = []; let n = 0;
  for (const o of offers) {
    let prev = null;
    for (const m of MILES) {
      if (m < (o.annual_mileage || 0)) continue;
      const r = pay(o, { userAnnualMileage: m });
      if (!r.computable) { bad.push(`${o.make} ${o.model} ${m}mi not computable`); continue; }
      n++;
      if (prev !== null && r.monthly < prev - 0.01)
        bad.push(`${o.make} ${o.model}: ${m}mi is CHEAPER ($${r.monthly.toFixed(2)} < $${prev.toFixed(2)})`);
      prev = r.monthly;
    }
  }
  return { n, bad };
});

// ── G. no absurd output anywhere in the state space ───────────────────────────
check("no absurd payment anywhere in the full state space",
  "any combination produces a payment <=$0 or >$6,000, or NaN", () => {
  const bad = []; let n = 0;
  for (const o of offers) for (const d of DOWNS) for (const m of MILES) {
    if (m < (o.annual_mileage || 0)) continue;
    const r = pay(o, { userDownPayment: d, userAnnualMileage: m });
    if (!r.computable) continue;
    n++;
    if (!isFinite(r.monthly) || r.monthly <= 0 || r.monthly > 6000)
      bad.push(`${o.make} ${o.model} $${d}/${m}mi -> $${r.monthly}`);
  }
  return { n, bad };
});

// ── H. every market: nothing shown unpriced-and-untagged ──────────────────────
check("every displayed deal is either priced for the market or tagged with its city",
  "a row is shown whose price is from another market AND has no city label", () => {
  const bad = []; let n = 0;
  for (const [region, label] of METROS) {
    const g = new Map();
    for (const o of offers) {
      const k = [o.make, o.model, o.trim || "", o.year, o.term_months, o.annual_mileage].join("|");
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(o);
    }
    for (const v of g.values()) {
      const pick = v.find(o => o.region === region) || v.find(o => pricedFor(o, region))
        || v.find(o => o.region === "national") || v[0];
      n++;
      if (pricedFor(pick, region)) continue;
      const city = METROS.find(m => m[0] === pick.region);
      if (!city) bad.push(`${label}: ${pick.make} ${pick.model} priced in ${pick.region} — NO CITY LABEL EXISTS`);
    }
  }
  return { n, bad };
});

// ── I. data integrity ─────────────────────────────────────────────────────────
check("offer data is complete and plausible",
  "a required field is missing, or a value is outside a believable range", () => {
  const bad = [];
  for (const o of offers) {
    const id = `${o.year} ${o.make} ${o.model}`;
    if (!o.monthly_payment || o.monthly_payment < 50 || o.monthly_payment > 5000) bad.push(`${id}: payment ${o.monthly_payment}`);
    if (!o.term_months || o.term_months < 12 || o.term_months > 60) bad.push(`${id}: term ${o.term_months}`);
    if (o.due_at_signing < 0 || o.due_at_signing > 25000) bad.push(`${id}: DAS ${o.due_at_signing}`);
    if (o.msrp != null && (o.msrp < 15000 || o.msrp > 250000)) bad.push(`${id}: MSRP ${o.msrp}`);
    if (!o.annual_mileage || o.annual_mileage < 5000 || o.annual_mileage > 25000) bad.push(`${id}: miles ${o.annual_mileage}`);
    if (!(o.trim || "").trim()) bad.push(`${id}: blank trim`);
    if (!o.msrp) bad.push(`${id}: no MSRP`);
  }
  return { n: offers.length, bad };
});

// ── J. two ads that are identical but priced differently ──────────────────────
check("no two identical ads carry different payments",
  "the same car/market/term/cash-down appears at two different advertised payments", () => {
  const g = new Map(); const bad = [];
  for (const o of offers) {
    const k = [o.make, o.model, o.trim || "", o.year, o.region, o.term_months,
               o.annual_mileage, o.due_at_signing, o.offer_end_date].join("|");
    if (!g.has(k)) g.set(k, new Set());
    g.get(k).add(o.monthly_payment);
  }
  for (const [k, v] of g) if (v.size > 1)
    bad.push(`${k.split("|").slice(0, 4).join(" ")} -> ${[...v].sort((a, b) => a - b).map(x => "$" + x).join(" / ")}`);
  return { n: g.size, bad };
});

// ── K. staleness ──────────────────────────────────────────────────────────────
check("offers have not expired",
  "an offer's end date is in the past", () => {
  const today = new Date().toISOString().slice(0, 10);
  const bad = []; let n = 0;
  for (const o of offers) {
    const raw = (o.offer_end_date || "").trim(); if (!raw) continue;
    let d = null;
    let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) d = `${m[1]}-${m[2]}-${m[3]}`;
    else if ((m = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/))) {
      const y = m[3].length === 2 ? "20" + m[3] : m[3];
      d = `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    }
    if (!d) continue;
    n++;
    if (d < today) bad.push(`${o.make} ${o.model} expired ${d}`);
  }
  return { n, bad };
});

// ── report ────────────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  const mark = { PASS: "PASS", FAIL: "FAIL", SKIP: "SKIP" }[r.status];
  console.log(`[${mark}] ${r.name}`);
  console.log(`        fails when: ${r.fails_when}`);
  console.log(`        ${r.n.toLocaleString()} cases checked, ${r.bad.length} problem(s)`);
  if (r.bad.length) {
    failed++;
    for (const b of r.bad.slice(0, 6)) console.log(`          - ${b}`);
    if (r.bad.length > 6) console.log(`          ... and ${r.bad.length - 6} more`);
  }
  console.log();
}
const total = results.reduce((a, r) => a + r.n, 0);
console.log("=".repeat(70));
console.log(`${results.length} checks · ${total.toLocaleString()} cases · ${failed} check(s) with problems`);
process.exit(failed ? 1 : 0);
