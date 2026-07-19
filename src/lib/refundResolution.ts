import { supabase } from "@/lib/supabase";

// Reference-number formats seen in real ICICI refund/reversal SMS. Tried in
// order; the first that matches wins.
const REFERENCE_PATTERNS = [/UPI\s*Ref\.?\s*(?:no\.?)?\s*:?\s*(\d{6,})/i, /UPI:\s*(\d{6,})/i];

function extractReferenceNumber(text: string): string | null {
  for (const pattern of REFERENCE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return null;
}

function looksLikeRefundOrReversal(text: string): boolean {
  return /\brefund\b/i.test(text) || /\breversal\b/i.test(text);
}

export type RefundResolutionReason =
  | "resolved"
  | "has_payee"
  | "not_refund_shaped"
  | "no_reference_found"
  | "no_match"
  | "ambiguous_match"
  | "match_has_no_payee";

export interface RefundResolutionOutcome {
  resolved: boolean;
  reason: RefundResolutionReason;
  referenceNumber?: string;
  matchedTransactionId?: number;
  matchedPayee?: string;
}

// Backfills payee + related_transaction_id for a payee-less refund/reversal
// transaction by finding the single earlier raw message that shares the same
// bank reference number (e.g. the UPI ref quoted in "...as reversal of
// transaction with UPI: 654194353908"). Only acts on an unambiguous match -
// zero or multiple candidates are left exactly as-is for a human to resolve
// via /review. Does NOT run categorization itself; callers decide what to do
// with the (possibly now-resolved) payee.
export async function tryResolveRefundReference(transaction: {
  id: number;
  payee: string | null;
  raw_message_id: number;
}): Promise<RefundResolutionOutcome> {
  if (transaction.payee) {
    return { resolved: false, reason: "has_payee" };
  }

  const { data: rawMessage, error: rawError } = await supabase
    .from("raw_messages")
    .select("id, message, created_at")
    .eq("id", transaction.raw_message_id)
    .single();
  if (rawError || !rawMessage) {
    console.error(`Failed to load raw message for transaction ${transaction.id}:`, rawError);
    return { resolved: false, reason: "no_reference_found" };
  }

  if (!looksLikeRefundOrReversal(rawMessage.message)) {
    return { resolved: false, reason: "not_refund_shaped" };
  }

  const referenceNumber = extractReferenceNumber(rawMessage.message);
  if (!referenceNumber) {
    return { resolved: false, reason: "no_reference_found" };
  }

  const { data: candidates, error: candidatesError } = await supabase
    .from("raw_messages")
    .select("id, transactions(id, payee)")
    .ilike("message", `%${referenceNumber}%`)
    .lt("created_at", rawMessage.created_at)
    .neq("id", rawMessage.id);

  if (candidatesError) {
    console.error(`Failed to search for refund reference match on transaction ${transaction.id}:`, candidatesError);
    return { resolved: false, reason: "no_match", referenceNumber };
  }

  if (!candidates || candidates.length === 0) {
    return { resolved: false, reason: "no_match", referenceNumber };
  }
  if (candidates.length > 1) {
    return { resolved: false, reason: "ambiguous_match", referenceNumber };
  }

  const matchedTransaction = candidates[0].transactions?.[0] ?? null;
  if (!matchedTransaction || !matchedTransaction.payee) {
    return { resolved: false, reason: "match_has_no_payee", referenceNumber };
  }

  const { error: updateError } = await supabase
    .from("transactions")
    .update({ payee: matchedTransaction.payee, related_transaction_id: matchedTransaction.id })
    .eq("id", transaction.id);

  if (updateError) {
    console.error(`Failed to backfill payee for refund transaction ${transaction.id}:`, updateError);
    return { resolved: false, reason: "no_match", referenceNumber };
  }

  return {
    resolved: true,
    reason: "resolved",
    referenceNumber,
    matchedTransactionId: matchedTransaction.id,
    matchedPayee: matchedTransaction.payee,
  };
}
