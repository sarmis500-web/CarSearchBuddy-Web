// engine.js — faithful JS ports of the native lease re-pricing engine
// (LeaseOffer.computePayment) and the auto-loan calculator (computeLoan).
// These MUST match the Kotlin to the penny — do not "improve" the math.

// ☠️☠️ THE TERM IS A FILTER, NOT A CALCULATOR. DO NOT RE-ADD RE-TERMING.
// Mirrors the header of native LeaseOffer.kt — keep the two identical. G10 gates it.
//
// Picking a term shows the deals the manufacturer ACTUALLY ADVERTISES at that term. We
// never compute a payment for a term the manufacturer did not advertise.
//
// ⭐ WHY (2026-07-24, non-circular). Every earlier figure compared our engine to OUR OWN
// ENGINE — hide a Kia's rate sheet, re-price it, compare to Kia. That cannot fail
// honestly. The real test sat unused in leases.json: Kia advertises the SAME trim,
// market, mileage, MSRP and expiry at BOTH 24 and 36 months — 82 vehicles, identical
// due-at-signing. Re-price ad A to ad B's term, compare to KIA'S OWN PUBLISHED PAYMENT.
// 162 predictions with Kia's real residual AND money factor at both ends:
//   median miss $6.48 │ within $10 68% │ within $15 83% │ worst $35.66
//   mean signed +$0.26 — CENTRED. We quote too LOW half the time.
// ⛔ That kills ceiling pricing: the "$10 cushion is never low, 176/176" claim was
// circular. Against real ads a $10 cushion holds 82.9%; 100% needs $35, on the BEST tier.
//
// ⭐ CAUSE, and why no engine fixes it: a maker publishes a SEPARATE PROGRAM PER TERM
// with different cash on each. Solving the implied cap from each ad (real residual + real
// MF at each term) shows the two programs differ by a median $194, up to $815 — and which
// term is cheaper is a COIN FLIP (52/48 over 81 vehicles). Unbiased scatter cannot be
// corrected; money that is not in the ad cannot be derived.
//
// ⛔ Do NOT re-attempt (all measured 2026-07-24, all failed): more OEM rate sheets
// (closed — Kia alone publishes); a fitted correction (was SHORTEN_RETERM_K, deleted —
// Kia-fitted, applied to ten other makes, which the product owner explicitly rejected);
// dropping outliers by solved rate (−3.3 pts); ceiling pricing (above). Residual and MF
// were NEVER the bottleneck — Kia's perfect ones still missed by $6.48.
//
// ⚠️ One screen DID work and was still rejected: error grows as ~0.57% of MSRP ÷ term, so
// hiding expensive-car/short-term re-prices lifts within-$15 from 83% to 95% (6-fold CV,
// split by vehicle, threshold stable at MSRP/term < $1,080 in all 6 folds). Rejected
// because 0.57% is ONE make in ONE program month — the whole catalogue was scraped the
// same day and 87% of offers expire within ~10 days of each other. A screen like that is
// a bet that must keep being true; showing only advertised terms cannot rot.

const LEASE_CONFIDENCE = {
  EXACT: "Advertised",
  HIGH: "Accurate estimate",
  MEDIUM: "Estimated — not an OEM offer",
  LOW: "Rough estimate",
  ADVERTISED_ONLY: "Advertised terms only",
};

function overageRatePerMile(make) {
  switch ((make || "").toLowerCase()) {
    case "bmw": case "mercedes-benz": case "mercedes": return 0.25;
    case "lexus": return 0.20;
    default: return 0.15;
  }
}

// Fallback-only: bills extra miles at the lease-end OVERAGE PENALTY rate, which is
// not how a lessor prices a higher allowance (buying miles up front is cheaper than
// being penalized for them later). Used only where we lack MSRP/residual and can't
// do it properly. Mirrors native LeaseOffer.mileageAdjustment.
function leaseMileageAdj(o, userAnnualMileage, term) {
  const annual = o.annual_mileage ?? 10000;
  const extraPerYear = Math.max(0, userAnnualMileage - annual);
  if (extraPerYear === 0 || term <= 0) return 0;
  const years = term / 12.0;
  return (extraPerYear * years * overageRatePerMile(o.make)) / term;
}

// Extra miles burn off residual at ~0.5 points of MSRP per 1,000 mi/yr ON A 36-MONTH
// lease, pro-rated by term — how the captive lender actually prices a higher
// allowance. Pro-rating matters because TOTAL extra miles devalue the car, not the
// annual rate: flat-per-year charged $0.56/mile on a 13-month S 500, more than double
// Mercedes' own $0.25 lease-end penalty. One-directional on purpose: the advertised
// allowance is the floor, so a default filter value can never re-price a deal below
// the ad. Mirrors native LeaseOffer.mileageResidualPenalty.
function mileageResidualPenalty(o, userAnnualMileage, term) {
  const annual = o.annual_mileage ?? 10000;
  const extraPerYear = Math.max(0, userAnnualMileage - annual);
  if (extraPerYear <= 0 || term <= 0) return 0;
  return extraPerYear / 1000.0 * 0.005 * (term / 36.0);
}

function effectiveMonthlyCost(o) {
  const term = o.term_months ?? 36;
  // Due-at-signing already INCLUDES the first month's payment, so only term-1 further
  // payments remain after signing (matches native effectiveMonthlyCost + the scraper's
  // total_lease_cost). Counting all `term` on top double-counts month one.
  return term > 0 ? ((o.due_at_signing ?? 0) + o.monthly_payment * (term - 1)) / term : o.monthly_payment;
}

/**
 * THE engine. Recompute pre-tax monthly for a requested term / down / mileage.
 * requestedTerm null → advertised term. Returns
 * { monthly, dueAtSigning, termMonths, confidence (key), computable }.
 */
function computeLeasePayment(o, { requestedTerm = null, userDownPayment = null, userAnnualMileage = null } = {}) {
  const termMonths = o.term_months ?? 36;
  const dueAtSigning = o.due_at_signing ?? 0;
  const annualMileage = o.annual_mileage ?? 10000;
  const monthlyPayment = o.monthly_payment;

  const targetTerm = requestedTerm ?? termMonths;
  const down = userDownPayment ?? dueAtSigning;
  const userMiles = userAnnualMileage ?? annualMileage;
  const termChanged = targetTerm !== termMonths;
  const downChanged = down !== dueAtSigning;
  const wantsMoreMiles = userMiles > annualMileage;

  // ── THE TERM GUARD: never price a term the manufacturer did not advertise ──
  // Rationale + the 162-prediction measurement: header above. Refusing here makes the
  // term control a FILTER — app.js hides any deal whose result is !computable, so picking
  // 36 months returns exactly the deals advertised at 36 months (428 of 627; 24mo -> 173).
  // Deals already advertised at the picked term never reach here (termChanged is false),
  // so they stay EXACT and show the maker's own number.
  // ⛔ Do NOT relax this to "only when we hold the OEM's per-term sheet" — that IS the
  // tier measured above, the best case, and it is still wrong half the time.
  if (termChanged) {
    return { monthly: monthlyPayment, dueAtSigning, termMonths,
             confidence: "ADVERTISED_ONLY", computable: false };
  }

  const { msrp, net_cap_cost: netCapCost, residual_value: residualValue, money_factor: moneyFactor } = o;
  const canRecompute = !!o.can_recompute;

  if (canRecompute && msrp != null && msrp > 0 && netCapCost != null &&
      residualValue != null && moneyFactor != null && targetTerm > 0) {
    // Prefer the OEM's own published residual for exactly this term. Deliberately NOT
    // clamped to [0.20, 0.80]: these are published facts, and real ones reach 84% of MSRP
    // on a 24-month Sportage PHEV. That band exists to bound the flat-slope EXTRAPOLATION
    // below — applying it to a rate sheet would corrupt it. Mirrors native LeaseOffer.
    // `targetTerm === termMonths` ALWAYS here (the term guard returned for every other
    // case), so this is the ADVERTISED term's residual and money factor, never an
    // extrapolation. What still varies is MILEAGE — a bigger allowance burns residual,
    // which is real lease math verified against Toyota's own published residuals (20
    // trims, 10k vs 12k, exactly 1.00 point of MSRP per +2,000 mi/yr at 36mo). Down
    // payment moves adjCap by construction (G7).
    const curveResidual = o.residual_curve ? o.residual_curve[String(targetTerm)] : null;
    let residual;
    if (curveResidual != null) {
      residual = Math.max(0, curveResidual - mileageResidualPenalty(o, userMiles, targetTerm) * msrp);
    } else {
      const advPct = residualValue / msrp;
      let termPct = advPct - mileageResidualPenalty(o, userMiles, targetTerm);
      termPct = Math.min(0.80, Math.max(0.20, termPct));
      residual = msrp * termPct;
    }
    const curveMf = o.mf_curve ? o.mf_curve[String(targetTerm)] : null;
    const mf = curveMf != null ? curveMf : moneyFactor;
    const adjCap = netCapCost - (down - dueAtSigning);
    const dep = (adjCap - residual) / targetTerm;
    const rent = (adjCap + residual) * mf;
    const monthly = dep + rent;

    // ── DEGENERATE INPUTS ARE NOT COMPUTABLE ──
    // Enough cash down drives the financed cap to or below the residual, so there is no
    // depreciation left to bill and the lease stops being one we can honestly price.
    // This USED to return the ADVERTISED payment with computable:true, which meant
    // $7,500 down on a Tacoma quoted $204 and $10,000 down quoted $309 — more money
    // down, HIGHER payment, on 160 offer/cash combinations (audit.js, 2026-07-24).
    // Refuse instead: the row is hidden or labelled, never contradicted.
    if (monthly <= 0 || adjCap <= residual) {
      return { monthly: monthlyPayment, dueAtSigning, termMonths, confidence: "ADVERTISED_ONLY", computable: false };
    }
    // `termChanged` is impossible here, so the only adjustments that reach this point are
    // DOWN PAYMENT and MILEAGE — within-program arithmetic on the maker's own advertised
    // deal, not an estimate of a program we have never seen. The old "Rough estimate"
    // branch existed for the term path, which no longer exists. Mirrors native.
    const confidence = (!downChanged && !wantsMoreMiles) ? "EXACT" : "HIGH";
    return { monthly, dueAtSigning: down, termMonths: targetTerm, confidence, computable: true };
  }

  // ── Fallback: no reverse-engineered params ──
  // (A term change never reaches here either — the term guard above returns first.)
  const downAdj = (down - dueAtSigning) / termMonths;
  const rawMonthly = monthlyPayment - downAdj + leaseMileageAdj(o, userMiles, termMonths);
  // Math.max(0, ...) used to clamp this and DISPLAY $0/mo — a Chevrolet Silverado at
  // $10,000 down showed a zero-dollar lease payment (audit.js, 2026-07-24). A payment
  // that would go negative means the cash down exceeds what this deal can absorb, which
  // we cannot price on the fallback path. Say so rather than print $0.
  if (rawMonthly <= 0) {
    return { monthly: monthlyPayment, dueAtSigning, termMonths, confidence: "ADVERTISED_ONLY", computable: false };
  }
  const monthly = rawMonthly;
  const confidence = (!downChanged && !wantsMoreMiles) ? "EXACT" : "LOW";
  return { monthly, dueAtSigning: down, termMonths, confidence, computable: true };
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
