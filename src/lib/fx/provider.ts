// The rate provider seam.
//
// Free exchange-rate APIs change hosts, add keys, or disappear - this app has
// already had to move from api.frankfurter.app to api.frankfurter.dev, and
// exchangerate.host started requiring an access key. So the provider is behind
// an interface with one method, and swapping it means writing one small file
// rather than touching the conversion or caching logic.

export interface RateQuote {
  /** Units of INR per one unit of the foreign currency. */
  rate: number;
  /**
   * The date the provider actually priced, which is NOT always the date asked
   * for: ECB publishes on business days only, so a weekend or holiday request
   * comes back priced on the previous business day. Recording the real date is
   * what makes the stored rate explainable later.
   */
  effectiveDate: string;
}

export interface RateProvider {
  readonly name: string;
  /**
   * Returns null when the provider has no rate for this currency/date - a
   * currency it does not carry, or a date before its history begins. Throws
   * only on transport failure, so callers can tell "no such rate" from
   * "could not reach the provider" and retry only the second.
   */
  fetchRate(currency: string, date: string): Promise<RateQuote | null>;
}
