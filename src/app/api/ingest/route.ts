import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { supabase } from "@/lib/supabase";
import { classify } from "@/lib/classify";
import { categorizeTransaction } from "@/lib/categorize";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
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
  if (typeof message !== "string" || message.trim().length === 0) {
    return NextResponse.json({ status: "OK" });
  }

  const sensitivePatterns = [/otp/i, /one-time password/i, /do not disclose/i];
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
  if (existing && Array.isArray(existing.transactions) && existing.transactions.length > 0) {
    return NextResponse.json({ status: "OK" });
  }

  let rawMessageId: number;
  if (existing) {
    rawMessageId = existing.id;
  } else {
    try {
      const { data, error } = await supabase
        .from("raw_messages")
        .insert({ message })
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
        await categorizeTransaction({
          id: transaction.id,
          payee: classified.payee,
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
