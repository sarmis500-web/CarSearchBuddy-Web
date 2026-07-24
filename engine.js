// engine.js — faithful JS ports of the native lease re-pricing engine
// (LeaseOffer.computePayment) and the auto-loan calculator (computeLoan).
// These MUST match the Kotlin to the penny — do not "improve" the math.

// Terms the GENERIC re-pricing (flat MF + ~7 pts/12mo residual slope) is measured to
// handle. Anything else needs the OEM's own curve. Mirrors native GENERIC_SAFE_TERMS.
//
// ☠️ 39 months is a PROGRAM CLIFF, not a point on a curve. Measured 2026-07-24 over all
// 177 Kia offers (the one make whose real per-term residual AND money factor we hold):
//   24mo median $15.05 (4.6%, over-quotes) │ 36mo $12.25 (4.0%)
//   39mo median $98.34 (23.2%) TOO LOW on 177/177 │ 48mo $50.65 (14.6%) TOO LOW on 177/177
// Kia's real 24→36 residual drop is 7.4 pts vs the 7.0 we assume — the slope is fine.
// But 36→39 drops 8.4 pts in THREE months while MF jumps 0.00230→0.00310 (+35%): the
// subvented promo doesn't extend to an odd term, so it prices at standard rates. A
// linear model cannot represent that, which is why every single offer errs the same
// way — always CHEAPER than reality.
// ⛔ Do NOT fit a 39-month correction from Kia's sheet: a cliff is program structure,
// not geometry. The OEM rate-sheet search is CLOSED — Kia is the only make that works.
const GENERIC_SAFE_TERMS = new Set([24, 36]);

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

  // ── PROGRAM-CLIFF GUARD (see GENERIC_SAFE_TERMS above) ──
  // Re-terming to 39/48 without the OEM's own curve understated the payment on 177 of
  // 177 measured offers — median $98/mo at 39. Refuse instead of guessing. The list
  // already hides deals it can't honestly re-price to a picked term. Deals ALREADY
  // advertised at that term never reach here (termChanged is false → they stay EXACT).
  if (termChanged && !GENERIC_SAFE_TERMS.has(targetTerm) &&
      (o.residual_curve?.[String(targetTerm)] == null ||
       o.mf_curve?.[String(targetTerm)] == null)) {
    return { monthly: monthlyPayment, dueAtSigning, termMonths,
             confidence: "ADVERTISED_ONLY", computable: false };
  }

  // ── ONE-WAY GUARD: a guessed residual may only be re-termed SHORTER ──
  // Where the residual had to be invented (residual_source === "curve"), every error
  // source pushes the same way, and the direction is set purely by the sign of
  // (1/target - 1/advertised). Simulated on the one captive whose real per-term residual
  // AND money factor we hold, processed as if it had no rate sheet:
  //   shorten to 24mo : OVER-quotes on 78 of 78, median +$34.64  -> tolerable
  //   lengthen to 36mo: UNDER-quotes on 67 of 67, median -$32.09, worst -$75.28
  // Under-quoting shows a payment cheaper than the customer can actually get, which this
  // product refuses. ⛔ Do NOT also block shortening — blocking both costs 72-91 shown
  // cars and removes four makes from a 24-month search; this costs 17. Mirrors native
  // LeaseOffer. (Independent audit, 2026-07-24.)
  if (termChanged && targetTerm > termMonths && o.residual_source === "curve") {
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
    const curveResidual = o.residual_curve ? o.residual_curve[String(targetTerm)] : null;
    let residual;
    if (curveResidual != null) {
      residual = Math.max(0, curveResidual - mileageResidualPenalty(o, userMiles, targetTerm) * msrp);
    } else {
      const advPct = residualValue / msrp;
      let termPct = advPct + (termMonths - targetTerm) / 12.0 * 0.07
                  - mileageResidualPenalty(o, userMiles, targetTerm);
      termPct = Math.min(0.80, Math.max(0.20, termPct));
      residual = msrp * termPct;
    }
    // The captive's money factor is NOT flat across terms — on Kia's own sheet it climbs on
    // all 18 models (Sportage 0.00204 @24mo -> 0.00310 @48mo, ~2.5 APR points). Re-terming
    // on the advertised term's MF left a median $43/mo error at 39 months and $27 at 48
    // (measured over all 177 Kia offers, 2026-07-24). Mirrors native LeaseOffer.
    const curveMf = o.mf_curve ? o.mf_curve[String(targetTerm)] : null;
    const mf = curveMf != null ? curveMf : moneyFactor;
    const adjCap = netCapCost - (down - dueAtSigning);
    const dep = (adjCap - residual) / targetTerm;
    const rent = (adjCap + residual) * mf;
    const monthly = dep + rent;

    if (monthly <= 0 || adjCap <= residual) {
      return { monthly: monthlyPayment, dueAtSigning, termMonths, confidence: "ADVERTISED_ONLY", computable: !termChanged };
    }
    // Order matters (this used to check paramsEstimated first, which labelled a
    // down-payment-only change "Rough estimate" on any curve-derived deal).
    // Measured across the 292 deals where we hold the OEM's real numbers, real vs
    // guessed params move a $0-down quote by a median $7.70 and a 15k-mile quote by
    // $1.67 — but a 24-month re-term by $51.82. Only term changes lean on parameter
    // quality. Mirrors native LeaseOffer.computePayment.
    const paramsEstimated = o.residual_source === "curve" || o.net_cap_source === "estimated";
    let confidence;
    if (!termChanged && !downChanged && !wantsMoreMiles) confidence = "EXACT";
    else if (!termChanged) confidence = "HIGH";
    else if (paramsEstimated) confidence = "LOW";
    else confidence = "MEDIUM";
    return { monthly, dueAtSigning: down, termMonths: targetTerm, confidence, computable: true };
  }

  // ── Fallback: no reverse-engineered params ──
  if (termChanged) {
    return { monthly: monthlyPayment, dueAtSigning, termMonths, confidence: "ADVERTISED_ONLY", computable: false };
  }
  const downAdj = (down - dueAtSigning) / termMonths;
  const monthly = Math.max(0, monthlyPayment - downAdj + leaseMileageAdj(o, userMiles, termMonths));
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
