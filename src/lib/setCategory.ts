/**
 * Correcting a transaction's category.
 *
 * One call site for every surface that can do it - the /transactions table, the
 * Review page, and the dashboard's transaction sheet - so a correction always
 * means the same thing: the transaction is updated, and merchant_categories is
 * upserted with confidence_source "manual" so every future transaction from
 * that payee inherits it. The server route does that work; this is the single
 * client-side path to it.
 */
export async function setTransactionCategory(transactionId: number, category: string): Promise<void> {
  const res = await fetch("/api/categorize/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transactionId, category }),
  });
  const json = await res.json();
  if (!res.ok || json.status !== "OK") {
    throw new Error(json.error ?? "Failed to save category");
  }
}
