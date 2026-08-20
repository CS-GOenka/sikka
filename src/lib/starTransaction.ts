/**
 * Flags a transaction for review. Starring is the existing mechanism - /review
 * selects on `starred` directly - so this is deliberately the same write the
 * star control on /transactions makes, rather than a second review flag that
 * could drift out of step with it.
 */
export async function setTransactionStarred(transactionId: number, starred: boolean): Promise<void> {
  const res = await fetch("/api/star", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transactionId, starred }),
  });
  const json = await res.json();
  if (!res.ok || json.status !== "OK") {
    throw new Error(json.error ?? "Failed to update star");
  }
}
