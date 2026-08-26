// Which credits are worth a push.
//
// Kept in its own module with no imports so the rule can be tested directly -
// budget.ts pulls in Supabase and web-push, which a unit test has no business
// loading. Same split as receivedAt.ts and duplicateCheck.ts.

export interface CreditNotifyRow {
  type: string;
  status: string | null;
  is_transfer: boolean;
  currency: string;
  amount: number | null;
  categories: { name: string } | null;
}

/**
 * Is this credit real money arriving that is worth interrupting for?
 *
 * Deliberately NOT gated on counts_as_spend, which is the rule debits use.
 * That flag answers "does this eat into my budget", a different question:
 * twelve of the fourteen credits it would suppress are Investments - including
 * a Rs 1,46,233 mutual-fund redemption - and money landing in the account is
 * exactly what a notification is for. Only Ignore is excluded, since that
 * category is the explicit "dismiss this" action.
 *
 * Transfers are excluded because they are the user's own money moving between
 * their own accounts, and the credit-card bill payments among them already
 * fire their own "payment received" push.
 */
export function shouldNotifyCredit(row: CreditNotifyRow): boolean {
  if (row.type !== "credit") return false;
  if (row.status !== "success") return false;
  if (row.is_transfer) return false;
  // Foreign credits are converted to INR at ingest before this runs; one still
  // in a foreign currency here failed conversion and has no trustworthy amount.
  if (row.currency !== "INR") return false;
  if (typeof row.amount !== "number" || row.amount <= 0) return false;
  if (row.categories?.name === "Ignore") return false;
  return true;
}
