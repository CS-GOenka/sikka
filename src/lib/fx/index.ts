// Converting a stored transaction in place.
import { supabase } from "@/lib/supabase";
import { convertToInr, describeBreakdown, type FxBreakdown } from "@/lib/fx/convert";
import { getRate } from "@/lib/fx/rates";
import { isConvertibleForeignCard, type FxCandidate } from "@/lib/fx/eligibility";
import type { RateProvider } from "@/lib/fx/provider";

export * from "@/lib/fx/convert";
export * from "@/lib/fx/eligibility";
export { getRate } from "@/lib/fx/rates";

export type FxOutcome =
  | { status: "skipped"; reason: string }
  | { status: "converted"; breakdown: FxBreakdown; effectiveDate: string; cached: boolean }
  | { status: "pending"; reason: string };

/**
 * Converts one foreign card transaction and writes the result.
 *
 * The converted total goes into `amount` and `currency` becomes 'INR', so every
 * existing spend query counts it without knowing anything about currencies. The
 * foreign figures move into the audit columns rather than being lost, which is
 * what makes this reconcilable against the card statement later.
 *
 * When no rate can be had the row is flagged `fx_pending` and left in its
 * foreign currency - out of spend totals, but findable and fixable. Guessing a
 * rate would put a wrong number somewhere nothing could later distinguish it
 * from a right one.
 */
export async function convertTransaction(
  transactionId: number,
  candidate: FxCandidate,
  provider?: RateProvider
): Promise<FxOutcome> {
  if (!isConvertibleForeignCard(candidate)) {
    return { status: "skipped", reason: "not a foreign-currency card charge" };
  }
  const currency = candidate.currency as string;
  const foreignAmount = candidate.amount as number;
  const date = candidate.transactionDate as string;

  const quote = await getRate(currency, date, provider);
  if (!quote) {
    const { error } = await supabase
      .from("transactions")
      .update({ fx_pending: true })
      .eq("id", transactionId);
    if (error) console.error(`Failed to flag transaction ${transactionId} as fx_pending:`, error);
    return { status: "pending", reason: `no rate available for ${currency} on ${date}` };
  }

  const breakdown = convertToInr(foreignAmount, currency, quote.rate);
  const { error } = await supabase
    .from("transactions")
    .update({
      amount: breakdown.totalInr,
      currency: "INR",
      original_amount: foreignAmount,
      original_currency: currency,
      fx_rate: quote.rate,
      fx_rate_date: quote.effectiveDate,
      fx_pending: false,
    })
    .eq("id", transactionId);

  if (error) {
    console.error(`Failed to store conversion for transaction ${transactionId}:`, error);
    return { status: "pending", reason: `write failed: ${error.message}` };
  }

  console.log(`Converted transaction ${transactionId}: ${describeBreakdown(breakdown)}`);
  return { status: "converted", breakdown, effectiveDate: quote.effectiveDate, cached: quote.cached };
}
