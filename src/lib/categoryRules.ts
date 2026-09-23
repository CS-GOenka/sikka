/**
 * The deterministic category rules, with no database or model behind them.
 *
 * Split out of categorize.ts because that module imports the Supabase and
 * Gemini clients at the top level, which makes it unimportable from a plain
 * node script. These two predicates are pure, and a backfill has to be able to
 * re-run them to recognise the categories they produced - so they live where
 * both a Next route and a script can reach them, and there is one copy rather
 * than a copy and a drifting duplicate.
 */

const INVESTMENT_PAYEE_MARKERS = ["zerodha", "groww", "upstox", "angelone", "angel one"];

export function isInvestmentTransaction(row: {
  payment_method: string;
  note: string | null;
  payee: string | null;
}): boolean {
  if (row.payment_method === "ach" && row.note && /nse\s*cleari/i.test(row.note)) {
    return true;
  }
  if (row.payee) {
    const lower = row.payee.toLowerCase();
    if (INVESTMENT_PAYEE_MARKERS.some((marker) => lower.includes(marker))) {
      return true;
    }
  }
  return false;
}

// Paan shops ("<name> Pan Shop", truncated to "Pan Sh") are an Indulgence.
// Matched on the whole word "pan" followed by "sh(op)" so it catches the shops
// without misfiring on people like "Pankaj", "Pritee Pandey" or "Shruti Panda".
export function isPaanShop(payee: string | null): boolean {
  if (!payee) return false;
  return /\bpan\s+sh/i.test(payee);
}

// Own-name transfers between the account holder's own accounts - never
// real spend, regardless of category.
const SELF_TRANSFER_NAMES = ["saurabh goenka"];

export function isSelfTransfer(payee: string | null): boolean {
  if (!payee) return false;
  return SELF_TRANSFER_NAMES.includes(payee.trim().toLowerCase());
}
