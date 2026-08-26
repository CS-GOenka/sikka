// Which transactions get converted.
//
// Scope is foreign-currency CARD transactions. Everything else that happens to
// quote a foreign amount is deliberately left alone - most of it is not a
// charge at all.

export interface FxCandidate {
  currency: string | null;
  amount: number | null;
  type: string;
  status: string | null;
  paymentMethod: string | null;
  transactionDate: string | null;
}

/**
 * A real foreign card charge, as opposed to a notice that merely mentions a
 * foreign amount.
 *
 * The exclusions matter. Standing-instruction activations ("Maximum Amount:
 * USD 150.00") quote a ceiling that was never charged and classify as
 * `ignored`. Declined and withheld transactions quote an amount that never
 * left the account. Converting either would invent spend that did not happen.
 */
export function isConvertibleForeignCard(t: FxCandidate): boolean {
  if (!t.currency || t.currency === "INR") return false;
  if (typeof t.amount !== "number" || t.amount <= 0) return false;
  if (t.type !== "debit" && t.type !== "credit") return false;
  if (t.status !== "success") return false;
  if (t.paymentMethod !== "card") return false;
  // No date means no rate to look up, and the transaction date is what the
  // conversion has to be priced on.
  if (!t.transactionDate) return false;
  return true;
}
