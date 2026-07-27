import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { supabase } from "@/lib/supabase";
import { classify } from "@/lib/classify";
import { categorizeTransaction } from "@/lib/categorize";
import { tryResolveRefundReference } from "@/lib/refundResolution";
import { tryResolveCcBillPayment } from "@/lib/ccBillPaymentResolution";
import { startTiming } from "@/lib/timing";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const endTiming = startTiming("POST /api/ingest");
  try {
    return await handleIngest(request);
  } finally {
    endTiming();
  }
}

async function handleIngest(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse ingest request body:", err);
    return NextResponse.json(
      { status: "ERROR", error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  const message = (body as { message?: unknown })?.message;
  const rawPhoneReceivedAt = (body as { phoneReceivedAt?: unknown })?.phoneReceivedAt;
  // No parsing/validation of the format yet - we don't know what shape the
  // Shortcut actually sends. Just log and capture it as-is.
  console.log("Raw phoneReceivedAt received:", rawPhoneReceivedAt);
  const phoneReceivedAt = typeof rawPhoneReceivedAt === "string" ? rawPhoneReceivedAt : null;

  if (typeof message !== "string" || message.trim().length === 0) {
    return NextResponse.json({ status: "OK" });
  }

  const sensitivePatterns = [
    /otp/i,
    /one.?time.?password/i,
    /do not (disclose|share)/i,
    /verification code/i,
    /security code/i,
  ];
  if (sensitivePatterns.some((pattern) => pattern.test(message))) {
    return NextResponse.json({ status: "OK" });
  }

  // Idempotency: if this exact message was already ingested (a Shortcut
  // retry, a duplicate SMS delivery, or a reconciliation re-send), don't
  // create a second raw_messages row. Compares both with and without a
  // trailing period, since different extraction paths (plain `text` column
  // vs decoded `attributedBody`) have been observed to disagree on that one
  // trailing character for otherwise identical messages.
  //
  // Important: a matching raw_messages row does NOT necessarily mean this
  // message was fully processed - if the transaction insert below ever
  // fails (e.g. a transient cold-start hiccup), the raw message is safely
  // stored but has no transaction yet. So we only short-circuit here if a
  // transaction already exists too; otherwise we resume processing using
  // the existing raw_messages row instead of skipping it, so a retry can
  // never leave a message permanently unclassified.
  const trimmed = message.trim();
  const dedupVariants = trimmed.endsWith(".")
    ? [trimmed, trimmed.slice(0, -1)]
    : [trimmed, `${trimmed}.`];
  const { data: existingRows, error: existingError } = await supabase
    .from("raw_messages")
    .select("id, transactions(id)")
    .in("message", dedupVariants)
    .limit(1);
  if (existingError) {
    console.error("Failed to check for duplicate raw message:", existingError);
  }
  const existing = existingRows?.[0];
  // transactions.raw_message_id is unique, so PostgREST embeds this as a
  // single object (or null), not an array.
  if (existing && existing.transactions) {
    return NextResponse.json({ status: "OK" });
  }

  let rawMessageId: number;
  if (existing) {
    rawMessageId = existing.id;
  } else {
    try {
      const { data, error } = await supabase
        .from("raw_messages")
        .insert({ message, phone_received_at: phoneReceivedAt })
        .select("id")
        .single();

      if (error || !data) {
        console.error("Supabase insert into raw_messages failed:", {
          message: error?.message,
          code: error?.code,
          details: error?.details,
          hint: error?.hint,
        });
        return NextResponse.json(
          { status: "ERROR", error: error?.message ?? "Insert returned no row" },
          { status: 500 }
        );
      }
      rawMessageId = data.id;
      console.log("Inserted raw message:", message);
    } catch (err) {
      console.error("Unexpected error inserting into raw_messages:", err);
      return NextResponse.json(
        { status: "ERROR", error: "Unexpected error while inserting message" },
        { status: 500 }
      );
    }
  }

  // Classification is pure regex (no external calls), so it runs inline -
  // every message that reaches here is classified automatically, with no
  // manual trigger required.
  const classified = classify(message);
  const { data: transaction, error: txnError } = await supabase
    .from("transactions")
    .insert({
      raw_message_id: rawMessageId,
      type: classified.type,
      payment_method: classified.paymentMethod,
      status: classified.status,
      account_type: classified.accountType,
      is_transfer: classified.isTransfer,
      card_or_account: classified.cardOrAccount,
      payee: classified.payee,
      note: classified.note,
      amount: classified.amount,
      currency: classified.currency,
      transaction_date: classified.transactionDate,
    })
    .select("id, type")
    .single();

  if (txnError || !transaction) {
    console.error("Failed to insert classified transaction:", txnError);
    // The raw message is safely stored either way; classification can be
    // recovered later. Still report OK to the caller since ingest itself
    // succeeded.
    return NextResponse.json({ status: "OK" });
  }

  // Categorization involves a Gemma call on a cache miss, which shouldn't
  // block (or risk timing out) the caller's response. Runs automatically
  // after the response is sent - no manual trigger required.
  if (transaction.type === "debit" || transaction.type === "credit") {
    after(async () => {
      try {
        if (transaction.type === "debit") {
          // Already tagged as a bill payment at classify time (BillDesk,
          // CRED) - skip categorization outright. Previously this fell
          // through to categorizeTransaction() anyway (tryResolveCcBillPayment
          // correctly declines to re-touch it, but declining isn't the same
          // as skipping), which really did assign real spend categories to
          // transfer transactions in production - caught via a merchant_categories
          // entry for "Credit Card Bill Payment" itself and at least one
          // affected transaction.
          if (classified.payee === "Credit Card Bill Payment") {
            // needs_category_review defaults to true at the DB level (a
            // fail-safe for categorization failures) and nothing else
            // clears it on this skip-categorization path, so it has to be
            // set explicitly here - otherwise a fully-resolved transfer
            // would incorrectly sit in the review queue forever.
            const { error: resolvedError } = await supabase
              .from("transactions")
              .update({ needs_category_review: false })
              .eq("id", transaction.id);
            if (resolvedError) {
              console.error(`Failed to clear needs_category_review for bill payment ${transaction.id}:`, resolvedError);
            }
            return;
          }

          // Any other debit not already tagged might still be a credit card
          // bill payment made via a different rail (ACH/UPI/NEFT) - a
          // separate confirmation SMS can confirm that by amount+date.
          // Confirmed matches are transfers, not real spend, so
          // categorization is skipped for them entirely.
          const ccOutcome = await tryResolveCcBillPayment({
            id: transaction.id,
            type: transaction.type,
            payee: classified.payee,
            amount: classified.amount,
            transaction_date: classified.transactionDate,
            account_type: classified.accountType,
            card_or_account: classified.cardOrAccount,
          });
          if (ccOutcome.resolved) {
            return;
          }
        }

        let payee = classified.payee;
        if (!payee) {
          // Payee-less refund/reversal messages (e.g. "...as reversal of
          // transaction with UPI: 654194353908") can often be resolved
          // automatically by matching that reference number back to the
          // original transaction it refers to.
          const refundOutcome = await tryResolveRefundReference({
            id: transaction.id,
            payee,
            raw_message_id: rawMessageId,
          });
          if (refundOutcome.resolved && refundOutcome.matchedPayee) {
            payee = refundOutcome.matchedPayee;
          }
        }
        await categorizeTransaction({
          id: transaction.id,
          payee,
          payment_method: classified.paymentMethod,
          note: classified.note,
        });
      } catch (err) {
        console.error(`Background categorization failed for transaction ${transaction.id}:`, err);
      }
    });
  }

  return NextResponse.json({ status: "OK" });
}
