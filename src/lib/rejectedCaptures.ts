// Share-sheet captures the ingest refused.
//
// The duplicate check runs before the raw_messages insert, so a rejected share
// used to write nothing at all while the endpoint still answered OK. A
// hand-shared transaction could disappear with nothing anywhere to say so -
// which is exactly how two Rs 500 poker payments went missing.
//
// A rejection is now recorded and surfaced until it is answered. Only manual
// captures are worth recording: the automatic path re-delivers the same SMS
// routinely, and a callout for each would be noise about something nobody did.
import { supabase } from "@/lib/supabase";

/**
 * How long an unanswered rejection stays on screen.
 *
 * Long enough to notice on the next look at the app, short enough that a
 * duplicate share nobody cares about does not sit there forever. Past this it
 * stops being shown; the row is kept so the history is still auditable.
 */
export const REJECTION_TTL_MS = 60 * 60 * 1000;

export interface RejectedCapture {
  id: number;
  message: string;
  amount: number | null;
  payee: string | null;
  transactionDate: string | null;
  matchedTransactionId: number | null;
  reason: string;
  createdAt: string;
}

interface RejectedRow {
  id: number;
  message: string;
  amount: number | null;
  payee: string | null;
  transaction_date: string | null;
  matched_transaction_id: number | null;
  reason: string;
  created_at: string;
}

export async function recordRejectedCapture(input: {
  message: string;
  amount: number | null;
  payee: string | null;
  transactionDate: string | null;
  matchedTransactionId: number;
  reason: string;
}): Promise<void> {
  const { error } = await supabase.from("rejected_captures").insert({
    message: input.message,
    amount: input.amount,
    payee: input.payee,
    transaction_date: input.transactionDate,
    matched_transaction_id: input.matchedTransactionId,
    reason: input.reason,
  });
  // Best effort: failing to record a rejection must not turn a duplicate into
  // an error the sender sees, but it must be loud in the log.
  if (error) console.error("Failed to record rejected capture:", error.message);
}

/** Unanswered rejections from the last hour - what the callout shows. */
export async function fetchPendingRejections(nowMs: number = Date.now()): Promise<RejectedCapture[]> {
  const since = new Date(nowMs - REJECTION_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from("rejected_captures")
    .select("id, message, amount, payee, transaction_date, matched_transaction_id, reason, created_at")
    .is("resolved_at", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .returns<RejectedRow[]>();
  if (error) {
    // A missing table (before the migration) or a transient failure must not
    // take a page down with it.
    console.error("Failed to load rejected captures:", error.message);
    return [];
  }
  return (data ?? []).map((r) => ({
    id: r.id,
    message: r.message,
    amount: r.amount === null ? null : Number(r.amount),
    payee: r.payee,
    transactionDate: r.transaction_date,
    matchedTransactionId: r.matched_transaction_id,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}
