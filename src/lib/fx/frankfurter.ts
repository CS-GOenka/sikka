// Frankfurter: ECB reference rates, free, no key, history back to 1999.
//
// Chosen over exchangerate.host, which now requires an access key on its free
// tier. The mid-market reference rate is not the rate a card network settles
// at - see the accuracy note in the FX report - but it is the right basis for
// an estimate that gets reconciled against the statement later.
import type { RateProvider, RateQuote } from "@/lib/fx/provider";

// The .dev host. The old api.frankfurter.app now answers 301, and a redirect
// that a fetch does not follow looks exactly like a dead provider.
const BASE_URL = "https://api.frankfurter.dev/v1";
const TIMEOUT_MS = 8000;

interface FrankfurterResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

export const frankfurterProvider: RateProvider = {
  name: "frankfurter",

  async fetchRate(currency: string, date: string): Promise<RateQuote | null> {
    const url = `${BASE_URL}/${date}?base=${encodeURIComponent(currency)}&symbols=INR`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });

    // A currency or date the provider does not carry is an answer, not a
    // failure: it will never succeed on retry, so it must not be thrown.
    if (response.status === 404 || response.status === 422) return null;
    if (!response.ok) {
      throw new Error(`Frankfurter returned ${response.status} for ${currency} on ${date}`);
    }

    const body = (await response.json()) as FrankfurterResponse;
    const rate = body?.rates?.INR;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
    return { rate, effectiveDate: body.date ?? date };
  },
};
