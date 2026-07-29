import { supabase } from "@/lib/supabase";
import { parseDate } from "@/lib/classify";

// Matches both real message shapes seen for these confirmations:
//   "Payment of Rs 67,035.51 has been received on your ICICI Bank Credit
//    Card XX2003 through Bharat Bill Payment System on 27-JAN-26."
//   "Dear Customer, Payment of INR 35,000.00 has been received on your
//    ICICI Bank Credit Card Account 4xxx2003 on 15-JUL-26.Thank you."
const CONFIRMATION_PATTERN =
  /Payment of (?:Rs\.?|INR)\s*([\d,]+\.?\d*)\s+has been received on your ICICI Bank Credit Card\s+(?:Account\s+)?(\S+?)(?:\s+through Bharat Bill Payment System)?\s+on\s+(\d{1,2}-[A-Za-z]{3}-\d{2,4})/i;

function parseConfirmationAmount(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

// Card numbers appear in different formats across message shapes (XX2003
// vs 4xxx2003) and against classify.ts's own captured format (just "2003").
// Comparing the last 4 digits sidesteps all of that.
function last4Digits(cardRef: string): string {
  return cardRef.replace(/\D/g, "").slice(-4);
}

function daysBetween(isoA: string, isoB: string): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.abs(new Date(`${isoA}T00:00:00Z`).getTime() - new Date(`${isoB}T00:00:00Z`).getTime()) / msPerDay;
}

export type CcBillPaymentReason =
  | "resolved"
  | "not_a_debit"
  | "already_billdesk"
  | "no_amount_or_date"
  | "no_match"
  | "ambiguous_match";

export interface CcBillPaymentOutcome {
  resolved: boolean;
  reason: CcBillPaymentReason;
  matchedRawMessageId?: number;
  matchedDate?: string;
}

// For any debit not already tagged as a bill payment by the payee-contains-
// "billdesk" rule in classify.ts, checks whether it matches a separate
// "Payment of INR X has been received on your ICICI Bank Credit Card..."
// confirmation SMS by amount and date. Most such debits (ACH/UPI/NEFT from
// a savings account) have no credit-card reference of their own, so card
// matching only applies as an extra check when the debit itself does carry
// one (e.g. a credit-card-side mandate debit) - otherwise amount+date alone
// decide it. Only acts on an unambiguous single match.
export async function tryResolveCcBillPayment(transaction: {
  id: number;
  type: string;
  payee: string | null;
  amount: number | null;
  transaction_date: string | null;
  account_type: string;
  card_or_account: string | null;
}): Promise<CcBillPaymentOutcome> {
  if (transaction.type !== "debit") {
    return { resolved: false, reason: "not_a_debit" };
  }
  if (transaction.payee === "Credit Card Bill Payment") {
    return { resolved: false, reason: "already_billdesk" };
  }
  if (transaction.amount === null || !transaction.transaction_date) {
    return { resolved: false, reason: "no_amount_or_date" };
  }

  const { data: candidates, error } = await supabase
    .from("raw_messages")
    .select("id, message")
    .ilike("message", "%has been received on your ICICI Bank Credit Card%");

  if (error || !candidates) {
    console.error(`Failed to search CC bill payment confirmations for transaction ${transaction.id}:`, error);
    return { resolved: false, reason: "no_match" };
  }

  const matches: { id: number; date: string }[] = [];
  for (const candidate of candidates) {
    const m = CONFIRMATION_PATTERN.exec(candidate.message);
    if (!m) continue;

    const confirmedAmount = parseConfirmationAmount(m[1]);
    if (Math.abs(confirmedAmount - transaction.amount) > 0.01) continue;

    const confirmedDate = parseDate(m[3]);
    if (!confirmedDate) continue;
    if (daysBetween(confirmedDate, transaction.transaction_date) > 3) continue;

    if (transaction.account_type === "credit_card" && transaction.card_or_account) {
      if (last4Digits(transaction.card_or_account) !== last4Digits(m[2])) continue;
    }

    matches.push({ id: candidate.id, date: confirmedDate });
  }

  if (matches.length === 0) {
    return { resolved: false, reason: "no_match" };
  }
  if (matches.length > 1) {
    return { resolved: false, reason: "ambiguous_match" };
  }

  const { error: updateError } = await supabase
    .from("transactions")
    .update({
      is_transfer: true,
      payee: "Credit Card Bill Payment",
      category_id: null,
      needs_category_review: false,
    })
    .eq("id", transaction.id);

  if (updateError) {
    console.error(`Failed to mark transaction ${transaction.id} as a credit card bill payment:`, updateError);
    return { resolved: false, reason: "no_match" };
  }

  return { resolved: true, reason: "resolved", matchedRawMessageId: matches[0].id, matchedDate: matches[0].date };
}

export function isCcPaymentConfirmation(text: string): boolean {
  return CONFIRMATION_PATTERN.test(text);
}

export interface DebitResolutionOutcome {
  resolved: boolean;
  reason: "resolved" | "not_a_confirmation" | "unparseable" | "query_error" | "no_match" | "ambiguous_match" | "update_error";
  transactionId?: number;
  amount?: number;
}

// The reverse direction of tryResolveCcBillPayment. tryResolveCcBillPayment
// runs when a *debit* is ingested and looks for a matching confirmation; but
// the confirmation SMS often arrives minutes after the debit (verified: a
// ₹51,000 debit landed 34 min before its confirmation), so at debit-ingest
// time there was nothing to match and the debit fell through to normal
// categorization. This runs when a *confirmation* is ingested and looks back
// for the debit that paid it, closing that ordering gap in either arrival
// order. Only acts on a single unambiguous match.
export async function tryResolveDebitForConfirmation(confirmationText: string): Promise<DebitResolutionOutcome> {
  const m = CONFIRMATION_PATTERN.exec(confirmationText);
  if (!m) return { resolved: false, reason: "not_a_confirmation" };

  const confirmedAmount = parseConfirmationAmount(m[1]);
  const cardRef = m[2];
  const confirmedDate = parseDate(m[3]);
  if (Number.isNaN(confirmedAmount) || !confirmedDate) {
    return { resolved: false, reason: "unparseable" };
  }

  const { data: candidates, error } = await supabase
    .from("transactions")
    .select("id, amount, transaction_date, account_type, card_or_account, payee")
    .eq("type", "debit")
    .eq("is_transfer", false)
    .gte("amount", confirmedAmount - 0.01)
    .lte("amount", confirmedAmount + 0.01);

  if (error || !candidates) {
    console.error("Failed to search debits for CC bill payment confirmation:", error);
    return { resolved: false, reason: "query_error" };
  }

  const matches = candidates.filter((c) => {
    if (c.payee === "Credit Card Bill Payment") return false; // already tagged
    if (!c.transaction_date) return false;
    if (daysBetween(confirmedDate, c.transaction_date) > 3) return false;
    // Only enforce the card match when the debit itself carries a card ref (a
    // credit-card-side debit). Savings-side transfers to the card have none.
    if (c.account_type === "credit_card" && c.card_or_account) {
      if (last4Digits(c.card_or_account) !== last4Digits(cardRef)) return false;
    }
    return true;
  });

  if (matches.length === 0) return { resolved: false, reason: "no_match" };
  if (matches.length > 1) return { resolved: false, reason: "ambiguous_match" };

  const { error: updateError } = await supabase
    .from("transactions")
    .update({ is_transfer: true, payee: "Credit Card Bill Payment", category_id: null, needs_category_review: false })
    .eq("id", matches[0].id);

  if (updateError) {
    console.error(`Failed to mark debit ${matches[0].id} as a credit card bill payment:`, updateError);
    return { resolved: false, reason: "update_error" };
  }

  return { resolved: true, reason: "resolved", transactionId: matches[0].id, amount: confirmedAmount };
}
