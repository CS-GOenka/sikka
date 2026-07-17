import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { categorizeMerchant } from "@/lib/gemini";

export async function POST() {
  const { data: rows, error } = await supabase
    .from("transactions")
    .select("id, payee, payment_method")
    .in("type", ["debit", "credit"])
    .not("payee", "is", null)
    .is("category", null);

  if (error) {
    console.error("Failed to fetch uncategorized transactions:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  const { data: known, error: knownError } = await supabase
    .from("merchant_categories")
    .select("payee, category");

  if (knownError) {
    console.error("Failed to fetch merchant_categories:", knownError);
    return NextResponse.json({ status: "ERROR", error: knownError.message }, { status: 500 });
  }

  const knownCategories = new Map((known ?? []).map((r) => [r.payee, r.category]));

  const results: {
    id: number;
    payee: string;
    category: string | null;
    needsReview: boolean;
    source: "cache" | "llm" | "llm_uncertain";
  }[] = [];
  const failures: { id: number; payee: string; error: string }[] = [];

  for (const row of rows) {
    const payee = row.payee as string;
    let category: string | null = null;
    let needsReview = true;
    let source: "cache" | "llm" | "llm_uncertain" = "llm_uncertain";

    const cachedCategory = knownCategories.get(payee);
    if (cachedCategory) {
      category = cachedCategory;
      needsReview = false;
      source = "cache";
    } else {
      try {
        category = await categorizeMerchant(payee);
        needsReview = category === null;
        source = category === null ? "llm_uncertain" : "llm";

        if (category !== null) {
          const confidenceSource = row.payment_method === "mandate" ? "mandate" : "llm";
          const { error: upsertError } = await supabase.from("merchant_categories").upsert(
            { payee, category, confidence_source: confidenceSource, updated_at: new Date().toISOString() },
            { onConflict: "payee" }
          );
          if (upsertError) {
            console.error(`Failed to cache category for payee "${payee}":`, upsertError);
          } else {
            knownCategories.set(payee, category);
          }
        }
      } catch (err) {
        console.error(`Failed to categorize transaction ${row.id} (payee: ${payee}):`, err);
        failures.push({
          id: row.id,
          payee,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    const { error: updateError } = await supabase
      .from("transactions")
      .update({ category, needs_category_review: needsReview })
      .eq("id", row.id);

    if (updateError) {
      console.error(`Failed to save category for transaction ${row.id}:`, updateError);
      failures.push({ id: row.id, payee, error: updateError.message });
      continue;
    }

    results.push({ id: row.id, payee, category, needsReview, source });
  }

  return NextResponse.json({
    status: "OK",
    categorized: results.length,
    failed: failures.length,
    results,
    failures,
  });
}
