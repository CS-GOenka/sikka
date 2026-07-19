import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { categorizeTransaction } from "@/lib/categorize";

export async function POST() {
  const { data: rows, error } = await supabase
    .from("transactions")
    .select("id, payee, payment_method, note")
    .in("type", ["debit", "credit"])
    .is("category_id", null);

  if (error) {
    console.error("Failed to fetch uncategorized transactions:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  const results = [];
  const failures = [];

  for (const row of rows) {
    const outcome = await categorizeTransaction(row);
    if (outcome.error) {
      failures.push({ id: outcome.id, payee: outcome.payee, error: outcome.error });
      continue;
    }
    results.push(outcome);
  }

  return NextResponse.json({
    status: "OK",
    categorized: results.length,
    failed: failures.length,
    results,
    failures,
  });
}
