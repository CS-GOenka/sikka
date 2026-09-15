/**
 * The Gmail query for ICICI transaction alerts.
 *
 * Pinned to two sender addresses AND their subject lines, because the sender
 * alone is not enough: credit_cards@icici.bank.in sends the monthly statements
 * from the same address as the alerts, each carrying a ~1.2MB PDF. A
 * sender-only match pulled two of those in a single 30-day window.
 *
 * customernotification@icici.bank.in is worse - it also sends OTP alerts and
 * "payee added" confirmations, neither of which is a transaction.
 *
 * Subjects are matched as exact phrases. ICICI has used these strings
 * unchanged across every alert observed, and the phrase match is the
 * difference between reading two senders' transaction mail and reading two
 * senders' mail.
 */
// ICICI migrated domains in April 2026: credit_cards@icicibank.com stops on
// 8 April 2026 and credit_cards@icici.bank.in starts on the 13th, with the same
// subject line either side. The old address is kept because a query that only
// knows the new one silently reads nothing if the bank ever reverts, and because
// this same query is what the 24-month backfill re-runs.
export const ICICI_SENDERS = [
  "credit_cards@icici.bank.in",
  "credit_cards@icicibank.com",
  "customernotification@icici.bank.in",
] as const;

export const ICICI_SUBJECTS = [
  "Transaction alert for your ICICI Bank Credit Card",
  "NEFT transaction through ICICI Bank iMobile",
  "IMPS transaction through ICICI Bank iMobile",
] as const;

export function iciciTransactionQuery(newerThanDays?: number): string {
  const from = ICICI_SENDERS.map((s) => `from:${s}`).join(" OR ");
  const subject = ICICI_SUBJECTS.map((s) => `subject:"${s}"`).join(" OR ");
  const age = newerThanDays ? ` newer_than:${newerThanDays}d` : "";
  return `{${from}} {${subject}}${age}`;
}
