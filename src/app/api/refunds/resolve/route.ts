import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { categorizeTransaction } from "@/lib/categorize";
import { tryResolveRefundReference } from "@/lib/refundResolution";

// Manual/retroactive run of the reference-number refund-matching logic
// against the current review queue. New messages get this automatically via
// /api/ingest; this exists to sweep up transactions that were already stuck
// in review before the matching logic existed.
export async function POST() {
  const { data: rows, error } = await supabase
    .from("transactions")
    .select("id, payee, payment_method, note, raw_message_id")
    .or("needs_category_review.eq.true,and(type.in.(debit,credit),category_id.is.null)");

  if (error) {
    console.error("Failed to fetch review queue for refund resolution:", error);
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  const resolved = [];
  const skipped = [];

  for (const row of rows) {
    const outcome = await tryResolveRefundReference(row);
    if (!outcome.resolved || !outcome.matchedPayee) {
      skipped.push({ id: row.id, reason: outcome.reason, referenceNumber: outcome.referenceNumber });
      continue;
    }

    const categorized = await categorizeTransaction({
      id: row.id,
      payee: outcome.matchedPayee,
      payment_method: row.payment_method,
      note: row.note,
    });

    resolved.push({
      id: row.id,
      payee: outcome.matchedPayee,
      referenceNumber: outcome.referenceNumber,
      matchedTransactionId: outcome.matchedTransactionId,
      categoryId: categorized.categoryId,
    });
  }

  return NextResponse.json({
    status: "OK",
    resolved: resolved.length,
    skipped: skipped.length,
    resolvedDetails: resolved,
    skippedDetails: skipped,
  });
}
