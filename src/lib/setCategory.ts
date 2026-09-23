/**
 * Correcting a transaction's category.
 *
 * One call site for every surface that can do it - the /transactions table, the
 * Review page, and the dashboard's transaction sheet - so a correction always
 * means the same thing on all three.
 *
 * Scope is the caller's to choose and defaults to this transaction alone. It
 * used to teach the merchant cache on every correction with no way to decline,
 * which meant one dismissed Blinkit charge quietly filed the next six as
 * non-spend and removed ₹4,973 from September's spend without saying so.
 */
export interface SetCategoryResult {
  /** Whether a merchant_categories row was actually written. */
  learned: boolean;
  /** Present when the caller asked to remember it and the server declined. */
  notLearnedReason?: string;
}

export async function setTransactionCategory(
  transactionId: number,
  category: string,
  options: { applyToPayee?: boolean } = {}
): Promise<SetCategoryResult> {
  const res = await fetch("/api/categorize/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transactionId, category, applyToPayee: options.applyToPayee === true }),
  });
  const json = await res.json();
  if (!res.ok || json.status !== "OK") {
    throw new Error(json.error ?? "Failed to save category");
  }
  return { learned: json.learned === true, notLearnedReason: json.notLearnedReason };
}
