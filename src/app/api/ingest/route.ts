import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { supabase } from "@/lib/supabase";
import { classify } from "@/lib/classify";
import { categorizeTransaction } from "@/lib/categorize";
import { tryResolveRefundReference } from "@/lib/refundResolution";
import {
  tryResolveCcBillPayment,
  isCcPaymentConfirmation,
  tryResolveDebitForConfirmation,
} from "@/lib/ccBillPaymentResolution";
import { notifyBudgetForSpend } from "@/lib/budget";
import { normalizePhoneReceivedAt } from "@/lib/phoneReceivedAt";
import { sendPushToAll } from "@/lib/push";
import { startTiming } from "@/lib/timing";

// Fires when a debit is confirmed as a credit-card bill payment (in either
// arrival order), so the user gets a positive "payment received" signal.
async function fireCcPaymentSuccessPush(amount: number | null): Promise<void> {
  const amt = amount != null ? `₹${amount.toLocaleString("en-IN")}` : "A payment";
  try {
    await sendPushToAll({
      title: "✅ Credit card payment received",
      body: `${amt} paid to your ICICI credit card`,
      tag: "sikka-ccpay",
      url: "/transactions",
    });
  } catch (err) {
    console.error("CC payment success push failed:", err);
  }
}

// Receipt time for a sender that didn't supply one (the Share Sheet shortcut).
//
// Same-day SMS  -> now. Accurate, and the only value that lets the row show up
//                  in /capture-check's rolling 1h/6h windows.
// Older SMS     -> 12:00 IST on the date parsed from the text. Backdated
//                  capture is the Share Sheet's whole purpose, so "now" would
//                  file a two-day-old spend under today's budget. Midday sits
//                  safely inside a budget day whatever the reset hour, unlike
//                  midnight, which a 03:00 reset would push into the day before.
// No date       -> now, as the only thing left.
const IST_OFFSET_MS = 330 * 60 * 1000;

function fallbackReceivedAt(transactionDate: string | null, nowMs: number = Date.now()): string {
  const m = transactionDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(transactionDate) : null;
  if (m) {
    // Is the SMS dated today, on the IST clock the rest of the app uses?
    const istNow = new Date(nowMs + IST_OFFSET_MS);
    const sameDay =
      istNow.getUTCFullYear() === +m[1] &&
      istNow.getUTCMonth() === +m[2] - 1 &&
      istNow.getUTCDate() === +m[3];
    // Same-day capture: "now" is both accurate (you share it when you see it)
    // and the only value that puts the row in /capture-check's rolling 1h/6h
    // windows - the whole point of that screen is confirming a capture just
    // landed, so a midday anchor would hide it there.
    if (sameDay) return new Date(nowMs).toISOString();
    const istNoonMs = Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0) - IST_OFFSET_MS;
    // Never invent a future receipt time (a mis-parsed or post-dated SMS).
    if (istNoonMs <= nowMs) return new Date(istNoonMs).toISOString();
  }
  return new Date(nowMs).toISOString();
}

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
  // Two senders use two shapes: the reconcile script sends UTC ISO-8601, the
  // iOS Shortcut sends an IST human string ("26 Jul 2026 at 12:37 AM").
  // Normalize both to one canonical UTC ISO-8601 string so phone_received_at
  // is consistently comparable - it's the anchor for the daily-budget day
  // boundary (created_at is unreliable for backfilled rows).
  const phoneReceivedAt = normalizePhoneReceivedAt(rawPhoneReceivedAt);
  if (rawPhoneReceivedAt != null && phoneReceivedAt === null) {
    console.warn("Unrecognized phoneReceivedAt format, falling back to the SMS date:", rawPhoneReceivedAt);
  }

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

  // Classification is pure regex (no external calls), so it runs inline -
  // every message that reaches here is classified automatically, with no
  // manual trigger required. It runs before the raw_messages insert because
  // the receipt-time fallback below uses the date it parses out of the SMS.
  const classified = classify(message);

  // A sender that omits phoneReceivedAt entirely - notably the "Send to Sikka"
  // Share Sheet shortcut, which posts only { message } - used to store null
  // here. That looked harmless because classification and categorization ran
  // normally, but phone_received_at is the anchor for every spend query:
  // computeTodaySpend and /capture-check both filter a range over it with an
  // !inner join, and notifyBudgetForSpend bails on a missing value. A null
  // therefore made a correctly-classified transaction silently invisible in
  // budget totals, in Capture Check, and to budget alerts - a manual capture
  // that looked captured but did not count.
  //
  // So fall back rather than storing null. The display layer already treats
  // created_at as an acceptable proxy for receipt time (see formatReceived);
  // this makes the spend layer agree instead of dropping the row.
  const effectivePhoneReceivedAt = phoneReceivedAt ?? fallbackReceivedAt(classified.transactionDate);

  let rawMessageId: number;
  if (existing) {
    rawMessageId = existing.id;
  } else {
    try {
      const { data, error } = await supabase
        .from("raw_messages")
        .insert({ message, phone_received_at: effectivePhoneReceivedAt })
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

  // Sanity guard: a parsed amount this large is far beyond any plausible
  // personal transaction (the largest real one on record is ~₹2 lakh) and
  // almost always signals a malformed or synthetic message - e.g. the
  // fabricated CRED test messages whose "amount" was the tail of the UPI
  // reference number. The parser itself is correct (the value really is in
  // the text), so this doesn't touch parsing; it just refuses to let such a
  // row flow through as a silently-resolved transaction. Instead it's left
  // with needs_category_review=true (the insert-time default) and skips
  // auto-categorization/bill-payment resolution below, so it surfaces in
  // /review for a human instead of quietly polluting spend/transfer totals.
  const AMOUNT_SANITY_CAP = 10_000_000; // ₹1 crore
  const suspiciousAmount = classified.amount !== null && classified.amount > AMOUNT_SANITY_CAP;

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
      // needs_category_review defaults to true at the DB level as a fail-safe
      // for a categorization step that fails partway. An "ignored" row has no
      // such step - categorization only runs for debit/credit, and nothing
      // downstream clears the flag for anything else - so leaving the default
      // in place just parks every non-transaction (promos, card-delivery and
      // activation notices, OTPs) in /review permanently. Recognising a
      // message as noise and then still asking to categorize it is the bug.
      ...(classified.type === "ignored" ? { needs_category_review: false } : {}),
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
        // Implausibly large amount: leave it flagged for review (the
        // needs_category_review insert default still stands) rather than
        // auto-resolving it as a bill payment or assigning a spend category.
        if (suspiciousAmount) {
          console.warn(
            `Transaction ${transaction.id} has an implausible amount (${classified.amount}); left flagged for review, skipping auto-categorization.`
          );
          return;
        }

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
            await fireCcPaymentSuccessPush(classified.amount);
            return;
          }

          // A bank fund transfer (INFT) that isn't a confirmed CC payment yet.
          // It's already marked is_transfer at classify time, so it's excluded
          // from spend and won't fire a budget alert. Don't LLM-categorize it;
          // just clear the review flag. If a "payment received" confirmation
          // later arrives, it's auto-labeled a CC bill payment and notified.
          if (classified.isTransfer) {
            const { error: transferError } = await supabase
              .from("transactions")
              .update({ needs_category_review: false })
              .eq("id", transaction.id);
            if (transferError) {
              console.error(`Failed to clear review flag for transfer ${transaction.id}:`, transferError);
            }
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

        // Now that the transaction is fully classified and categorized, fire a
        // daily-budget notification if (and only if) it's a qualifying spend.
        // notifyBudgetForSpend re-reads the final state and no-ops for
        // transfers/credits/investments/failed/non-INR. Only debits can
        // qualify, so credits skip it outright.
        if (transaction.type === "debit") {
          await notifyBudgetForSpend(transaction.id);
        }
      } catch (err) {
        console.error(`Background categorization failed for transaction ${transaction.id}:`, err);
      }
    });
  }

  // If this message is a "payment received on your ICICI Bank Credit Card"
  // confirmation, retroactively resolve the debit that paid it. The debit is
  // often ingested before this confirmation arrives, so its own forward
  // matching (tryResolveCcBillPayment) found nothing at the time - this closes
  // that gap regardless of arrival order.
  if (isCcPaymentConfirmation(message)) {
    after(async () => {
      try {
        const outcome = await tryResolveDebitForConfirmation(message);
        if (outcome.resolved) {
          console.log(`Resolved debit ${outcome.transactionId} as a credit card bill payment from a confirmation SMS`);
          await fireCcPaymentSuccessPush(outcome.amount ?? null);
        }
      } catch (err) {
        console.error("Reverse CC bill payment resolution failed:", err);
      }
    });
  }

  return NextResponse.json({ status: "OK" });
}
