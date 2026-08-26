// Cached rate lookup.
//
// Every rate ever fetched is stored under the date it was requested for, so a
// currency/date pair is fetched at most once however many transactions share
// it - and so the app keeps converting when the provider is unreachable, using
// what it already knows.
import { supabase } from "@/lib/supabase";
import { frankfurterProvider } from "@/lib/fx/frankfurter";
import type { RateProvider, RateQuote } from "@/lib/fx/provider";

export interface CachedRate extends RateQuote {
  provider: string;
  /** True when this came from the cache rather than the network. */
  cached: boolean;
}

interface FxRateRow {
  rate: number;
  effective_date: string;
  provider: string;
}

/**
 * The rate to convert `currency` on `date`, or null if none can be had.
 *
 * Null means "flag this transaction and try again later" - never "assume
 * something". A guessed rate would be indistinguishable from a real one once
 * stored, which is exactly the failure that makes a spend total quietly wrong.
 */
export async function getRate(
  currency: string,
  date: string,
  provider: RateProvider = frankfurterProvider
): Promise<CachedRate | null> {
  const { data: cached, error: readError } = await supabase
    .from("fx_rates")
    .select("rate, effective_date, provider")
    .eq("currency", currency)
    .eq("rate_date", date)
    .maybeSingle<FxRateRow>();

  if (readError) {
    // A broken cache must not stop a conversion the provider could still serve.
    console.error(`fx_rates read failed for ${currency} ${date}:`, readError.message);
  } else if (cached) {
    return {
      rate: Number(cached.rate),
      effectiveDate: cached.effective_date,
      provider: cached.provider,
      cached: true,
    };
  }

  let quote: RateQuote | null;
  try {
    quote = await provider.fetchRate(currency, date);
  } catch (err) {
    // Transport failure. Nothing cached and nothing fetched, so the caller
    // flags the transaction rather than converting it wrongly.
    console.error(`Rate provider ${provider.name} failed for ${currency} ${date}:`, err);
    return null;
  }
  if (!quote) return null;

  // Cached under the REQUESTED date, not the effective one: a Saturday and the
  // Friday it resolves to are separate keys, so asking for that Saturday again
  // is a cache hit rather than a second network call.
  const { error: writeError } = await supabase.from("fx_rates").upsert(
    {
      currency,
      rate_date: date,
      rate: quote.rate,
      effective_date: quote.effectiveDate,
      provider: provider.name,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "currency,rate_date" }
  );
  if (writeError) {
    // Worth having the rate without caching it; the next call just refetches.
    console.error(`fx_rates write failed for ${currency} ${date}:`, writeError.message);
  }

  return { ...quote, provider: provider.name, cached: false };
}
