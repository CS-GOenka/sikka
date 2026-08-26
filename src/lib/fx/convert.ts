// Turning a foreign card charge into rupees.
//
// ICICI does not bill the mid-market rate. It bills the card network's rate,
// then adds a cross-currency markup, then GST on that markup - so the number
// that lands on the statement is meaningfully larger than amount x rate, and
// using the bare conversion would understate every foreign transaction by
// roughly 4%.

/** Cross-currency markup ICICI applies on the converted amount. */
export const FX_MARKUP_RATE = 0.035;
/** GST is charged on the markup only, not on the converted amount. */
export const GST_ON_MARKUP_RATE = 0.18;

export interface FxBreakdown {
  foreignAmount: number;
  currency: string;
  rate: number;
  /** amount x rate, before any charges. */
  baseInr: number;
  markupInr: number;
  gstInr: number;
  /** What the card is expected to be billed. */
  totalInr: number;
}

/** Money, to the paisa. Rounding once at the end would let the parts stop summing to the total. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * base -> markup -> GST on the markup -> total.
 *
 * Each component is rounded to paisa as it is computed, so the stored
 * breakdown adds up exactly to the stored total. Reconciling against a
 * statement later means comparing these numbers to real ones, and a total that
 * does not equal the sum of its own parts makes that comparison impossible to
 * reason about.
 */
export function convertToInr(foreignAmount: number, currency: string, rate: number): FxBreakdown {
  if (!Number.isFinite(foreignAmount) || foreignAmount < 0) {
    throw new Error(`Invalid foreign amount: ${foreignAmount}`);
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Invalid rate for ${currency}: ${rate}`);
  }
  const baseInr = round2(foreignAmount * rate);
  const markupInr = round2(baseInr * FX_MARKUP_RATE);
  const gstInr = round2(markupInr * GST_ON_MARKUP_RATE);
  return {
    foreignAmount,
    currency,
    rate,
    baseInr,
    markupInr,
    gstInr,
    totalInr: round2(baseInr + markupInr + gstInr),
  };
}

// 0.035 * 100 is 3.5000000000000004 in binary floating point, which is not
// something to print in an audit line.
function pct(fraction: number): string {
  return `${Number((fraction * 100).toFixed(4))}%`;
}

/** A one-line audit trail for logs and reports. */
export function describeBreakdown(b: FxBreakdown): string {
  return (
    `${b.currency} ${b.foreignAmount} x ${b.rate} = ₹${b.baseInr}` +
    ` + markup ₹${b.markupInr} (${pct(FX_MARKUP_RATE)})` +
    ` + GST ₹${b.gstInr} (${pct(GST_ON_MARKUP_RATE)} of markup)` +
    ` = ₹${b.totalInr}`
  );
}
