#!/usr/bin/env node
/**
 * uncertainty.js — "How far off can this payment be?"  Answered per deal, in dollars.
 *
 * We KNOW the advertised payment exactly (it is the manufacturer's own published
 * number). What we do NOT know for some makes is the residual and the selling price.
 * So bound it honestly:
 *
 *   for each offer, sweep the residual across its whole plausible range and the selling
 *   price across its whole plausible range; for every combination, RE-SOLVE the money
 *   factor so the advertised payment still reproduces exactly (it must -- it is a
 *   published fact); then re-price the user's adjusted payment.
 *
 * The spread of those re-priced payments IS our uncertainty. It is not a guess about
 * our accuracy; it is the full set of worlds consistent with what the maker published.
 *
 * A deal the user has not adjusted has ZERO uncertainty -- nothing is computed.
 *
 * ============================================================================
 * ⚠️ WHAT THIS DOES AND DOES NOT PROVE  (added 2026-07-26, after running it)
 * ============================================================================
 * NOT WIRED INTO THE APP, deliberately. index.html does not load it. It is an
 * internal instrument, run by hand: `node uncertainty.js`.
 *
 * ⛔ It is a SENSITIVITY ANALYSIS, not a validated uncertainty. Read the output
 * knowing that 469 of 621 offers come back at exactly $0.00 BY CONSTRUCTION, not
 * by measurement: RES_BAND.oem/.parsed and CAP_BAND.oem_solved/.parsed are all
 * hardcoded 0.00 below. Those zeros are the assumption "a published residual and
 * a stated selling price are exactly right" -- restated as a result. Only the 152
 * estimated-residual offers get a computed spread (median $6.68, worst $35.76).
 *
 * ⛔ The two non-zero bands are ASSERTED, never measured: residual ±5 points of
 * MSRP and selling price ±6% of MSRP. The ±6% is justified in the comment below
 * by "real disclosed discounts run 0-38%", which is not the same interval. If
 * either band is too narrow the tool UNDERSTATES uncertainty, which is worse than
 * printing nothing, because the output looks rigorous.
 *
 * ⭐ MEASURED RESULT WORTH KEEPING (2026-07-26 data, 627 offers): the default
 * screen and the term filter carry $0.00 spread, and mileage changes are worst
 * $9.91 / 100% within $15. Material spread exists ONLY on cash-down changes on
 * the estimated tier. So a "±$X" band in the UI would read ±$0 on ~75% of cards
 * and on every unadjusted one -- visual noise plus an implicit accuracy claim,
 * for very little information. That is why it is not wired in.
 *
 * ⛔ Do not "validate" it against our own engine -- that is the circular mistake
 * that cost the project a day (see LeaseOffer.kt's header). A real test needs a
 * maker's published payment for a car whose residual we ESTIMATE, and no such
 * ground truth exists: the makes we can verify are exactly the makes we don't
 * estimate. Same disjoint-sets wall as the term problem.
 */
const fs = require("fs");
const path = require("path");
const LEASES = path.join(__dirname,
  "../CarSearchBuddy/composeApp/src/commonMain/composeResources/files/leases.json");
const offers = JSON.parse(fs.readFileSync(LEASES, "utf8")).offers;

// Plausible ranges. Residual: parsed/OEM values are published facts (tight); curve
// values are ours (wide). Selling price: parsed is stated in the ad; estimated is a
// flat 7% assumption while real disclosed discounts run 0-38%, so sweep that spread.
const RES_BAND = { oem: 0.00, parsed: 0.00, curve: 0.05 };   // ± points of MSRP
const CAP_BAND = { oem_solved: 0.00, parsed: 0.00, estimated: 0.06 }; // ± share of MSRP

function solveMf(cap, res, pay, T) { return (pay - (cap - res) / T) / (cap + res); }

function priceRange(o, down, miles) {
  const T = o.term_months, msrp = o.msrp;
  if (!msrp || !o.net_cap_cost || !o.residual_value || !o.can_recompute) return null;
  const rb = RES_BAND[o.residual_source] ?? 0.05;
  const cb = CAP_BAND[o.net_cap_source] ?? 0.06;
  const pen = Math.max(0, (miles - (o.annual_mileage || 0))) / 1000 * 0.005 * (T / 36);
  const out = [];
  for (const dr of [-rb, 0, rb]) for (const dc of [-cb, 0, cb]) {
    const res0 = o.residual_value + dr * msrp;          // world's residual at adv term
    const cap0 = o.net_cap_cost + dc * msrp;            // world's selling price
    if (res0 <= 0 || cap0 <= res0) continue;
    const mf = solveMf(cap0, res0, o.monthly_payment, T);   // forced: ad reproduces
    if (!(mf >= 0 && mf <= 0.005)) continue;                // implausible world, discard
    const res = Math.max(0, res0 - pen * msrp);
    const cap = cap0 - (down - o.due_at_signing);
    if (cap <= res) continue;
    const p = (cap - res) / T + (cap + res) * mf;
    if (p > 0) out.push(p);
  }
  return out.length ? { lo: Math.min(...out), hi: Math.max(...out), n: out.length } : null;
}

const SCENARIOS = [
  ["untouched (default screen / term filter)", null, null],
  ["cash down -> $2,000", 2000, null],
  ["cash down -> $0", 0, null],
  ["mileage -> 12,000/yr", null, 12000],
  ["mileage -> 15,000/yr", null, 15000],
  ["cash $2,000 AND 15,000 mi/yr", 2000, 15000],
];

console.log("HOW FAR OFF CAN THE SHOWN PAYMENT BE?");
console.log("Full range of worlds consistent with the manufacturer's published ad.\n");
console.log("scenario".padEnd(42) + "n".padStart(5) + "median".padStart(9) +
            "90th".padStart(8) + "worst".padStart(8) + "  within $15");

for (const [label, down, miles] of SCENARIOS) {
  const spreads = [];
  for (const o of offers) {
    const d = down === null ? o.due_at_signing : down;
    const m = miles === null ? o.annual_mileage : miles;
    if (down === null && miles === null) { spreads.push(0); continue; }  // nothing computed
    const r = priceRange(o, d, m);
    if (r) spreads.push(r.hi - r.lo);
  }
  if (!spreads.length) { console.log(label.padEnd(42) + "  (no deals)"); continue; }
  spreads.sort((a, b) => a - b);
  const q = f => spreads[Math.min(spreads.length - 1, Math.floor(spreads.length * f))];
  const within = 100 * spreads.filter(x => x <= 15).length / spreads.length;
  console.log(label.padEnd(42) + String(spreads.length).padStart(5) +
    ("$" + q(0.5).toFixed(2)).padStart(9) + ("$" + q(0.9).toFixed(2)).padStart(8) +
    ("$" + spreads[spreads.length - 1].toFixed(2)).padStart(8) +
    ("  " + within.toFixed(0) + "%").padStart(12));
}

console.log("\nBY HOW MUCH WE KNOW ABOUT THE CAR (cash down -> $2,000):");
const byTier = {};
for (const o of offers) {
  const r = priceRange(o, 2000, o.annual_mileage);
  if (!r) continue;
  const tier = (o.residual_source === "oem") ? "OEM rate sheet (Kia)"
    : (o.residual_source === "parsed") ? "residual in the maker's fine print"
    : "residual estimated by us";
  (byTier[tier] = byTier[tier] || []).push(r.hi - r.lo);
}
for (const [tier, v] of Object.entries(byTier).sort((a, b) => b[1].length - a[1].length)) {
  v.sort((a, b) => a - b);
  const med = v[Math.floor(v.length / 2)], worst = v[v.length - 1];
  const w15 = 100 * v.filter(x => x <= 15).length / v.length;
  console.log(`  ${tier.padEnd(38)} n=${String(v.length).padStart(3)}  ` +
    `median $${med.toFixed(2).padStart(6)}  worst $${worst.toFixed(2).padStart(7)}  within $15 ${w15.toFixed(0)}%`);
}
