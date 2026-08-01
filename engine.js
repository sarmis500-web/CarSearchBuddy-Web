// engine.js — ADAPTER over the COMPILED native lease engine (engine-kt/engine-kt.js).
//
// ⭐ THE LEASE MATH IS NOT HERE ANY MORE. Since 2026-08-01 the payment engine running on
// this page IS the native Kotlin engine — composeApp's LeaseOffer.kt compiled to JS by
// the native repo's :engineWeb module. A Kotlin engine fix reaches the web by REBUILDING,
// never by hand-porting:
//
//     cd ~/Projects/CarSearchBuddy && ./gradlew :engineWeb:deployWebEngine
//     then bump engine-kt/engine-kt.js?v= and engine.js?v= in index.html and push.
//
// ./drift-check.command (native repo) proves this adapter + bundle reproduce the Kotlin
// engine bit-for-bit over the whole catalog (551 offers × 9 scenarios) and self-tests
// that it can fail. Run it after any engine or adapter change.
//
// ☠️ THE TERM IS A FILTER, NOT A CALCULATOR — the full measured rationale lives in ONE
// place now: the HEADER COMMENT of LeaseOffer.kt (native repo). Do not re-add re-terming
// here, and do not re-add hand-written lease math here — that is the drift this
// architecture exists to make impossible. G10 and drift-check gate it.
//
// computeLoan (auto-loan calculator) stays hand-written JS below — it is not part of the
// lease engine (its native counterpart lives in the calculator screen, not LeaseOffer).

const __kt = (typeof window !== "undefined" && window.csbEngineKt)
  ? window.csbEngineKt
  : require("./engine-kt/engine-kt.js"); // Node path — used by drift-check
const __WebLeaseOffer = __kt.com.carsearchbuddy.web.WebLeaseOffer;

const LEASE_CONFIDENCE = {
  EXACT: "Advertised",
  HIGH: "Accurate estimate",
  MEDIUM: "Estimated — not an OEM offer",
  LOW: "Rough estimate",
  ADVERTISED_ONLY: "Advertised terms only",
};

// One parsed-once Kotlin handle per offer object. Offers are fetched once by app.js and
// never mutated, so identity-keying is safe; a WeakMap lets refreshed offer arrays fall
// away with their handles.
const __ktHandles = new WeakMap();
function __ktOffer(o) {
  let h = __ktHandles.get(o);
  if (!h) { h = new __WebLeaseOffer(JSON.stringify(o)); __ktHandles.set(o, h); }
  return h;
}

/**
 * THE engine (compiled Kotlin). Same contract as always: requestedTerm null → advertised
 * term. Returns { monthly, dueAtSigning, termMonths, confidence (key), computable }.
 */
function computeLeasePayment(o, { requestedTerm = null, userDownPayment = null, userAnnualMileage = null } = {}) {
  return JSON.parse(__ktOffer(o).compute(requestedTerm, userDownPayment, userAnnualMileage));
}

function effectiveMonthlyCost(o) {
  return __ktOffer(o).effectiveMonthlyCost();
}

/** Auto-loan payment. i: {vehiclePrice, docFee, titleLicenseFee, salesTaxRatePct,
 *  taxFullPrice, tradeInValue, tradeInPayoff, downPayment, aprPct, termMonths}. */
function computeLoan(i) {
  const taxableBase = i.taxFullPrice ? i.vehiclePrice : Math.max(0, i.vehiclePrice - i.tradeInValue);
  const salesTax = taxableBase * (i.salesTaxRatePct / 100.0);
  const amountFinanced = Math.max(0,
    i.vehiclePrice + i.docFee + i.titleLicenseFee + salesTax - i.tradeInValue + i.tradeInPayoff - i.downPayment);
  const computable = i.vehiclePrice > 0 && i.termMonths > 0 && amountFinanced > 0;
  let monthly = 0;
  if (computable) {
    const r = i.aprPct / 100.0 / 12.0;
    monthly = r === 0 ? amountFinanced / i.termMonths
                      : amountFinanced * r / (1 - Math.pow(1 + r, -i.termMonths));
  }
  return { monthlyPayment: monthly, salesTax, amountFinanced, computable };
}

if (typeof window !== "undefined") {
  Object.assign(window, { LEASE_CONFIDENCE, computeLeasePayment, computeLoan, effectiveMonthlyCost });
}
if (typeof module !== "undefined") module.exports = { computeLeasePayment, computeLoan, LEASE_CONFIDENCE, effectiveMonthlyCost };
