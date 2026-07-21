import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { tryResolveCcBillPayment } from "@/lib/ccBillPaymentResolution";

// Manual/retroactive run of CC-bill-payment matching against every existing
// debit transaction not already tagged by the billdesk-payee rule. New
// transactions get this automatically via /api/ingest going forward; this
// sweeps up ones that predate the matching logic.
export async function POST() {
  const { data: rows, error } = await supabase
    .from("transactions")
    .select("id, type, payee, amount, transaction_date, account_type, card_or_account")
    .eq("type", "debit")
    // NULL payees must stay included - a plain .neq() would silently drop
    // them, since `NULL != 'x'` is NULL (not true) in Postgres.
    .or("payee.is.null,payee.neq.Credit Card Bill Payment");

  if (error) {
    console.error("Failed to fetch debit transactions for CC bill payment resolution:", error);
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  const resolved = [];
  const skipped: { id: number; reason: string }[] = [];

  for (const row of rows) {
    const outcome = await tryResolveCcBillPayment(row);
    if (!outcome.resolved) {
      if (outcome.reason !== "already_billdesk" && outcome.reason !== "not_a_debit") {
        skipped.push({ id: row.id, reason: outcome.reason });
      }
      continue;
    }
    resolved.push({
      id: row.id,
      previousPayee: row.payee,
      amount: row.amount,
      transactionDate: row.transaction_date,
      matchedRawMessageId: outcome.matchedRawMessageId,
      matchedDate: outcome.matchedDate,
    });
  }

  return NextResponse.json({
    status: "OK",
    resolved: resolved.length,
    resolvedDetails: resolved,
    skippedWithReason: skipped,
  });
}
