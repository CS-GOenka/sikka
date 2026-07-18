import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { categorizeMerchant } from "@/lib/gemini";

const INVESTMENT_PAYEE_MARKERS = ["zerodha", "groww", "upstox", "angelone", "angel one"];

function isInvestmentTransaction(row: { payment_method: string; note: string | null; payee: string | null }): boolean {
  if (row.payment_method === "ach" && row.note && /nse\s*cleari/i.test(row.note)) {
    return true;
  }
  if (row.payee) {
    const lower = row.payee.toLowerCase();
    if (INVESTMENT_PAYEE_MARKERS.some((marker) => lower.includes(marker))) {
      return true;
    }
  }
  return false;
}

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

  const { data: categories, error: categoriesError } = await supabase
    .from("categories")
    .select("id, name");
  if (categoriesError) {
    console.error("Failed to fetch categories:", categoriesError);
    return NextResponse.json({ status: "ERROR", error: categoriesError.message }, { status: 500 });
  }
  const investmentsCategory = categories.find((c) => c.name === "Investments");
  if (!investmentsCategory) {
    return NextResponse.json(
      { status: "ERROR", error: "Investments category not found in categories table" },
      { status: 500 }
    );
  }

  const { data: known, error: knownError } = await supabase
    .from("merchant_categories")
    .select("payee, category_id");

  if (knownError) {
    console.error("Failed to fetch merchant_categories:", knownError);
    return NextResponse.json({ status: "ERROR", error: knownError.message }, { status: 500 });
  }

  const knownCategories = new Map((known ?? []).map((r) => [r.payee, r.category_id]));

  const results: {
    id: number;
    payee: string | null;
    categoryId: number | null;
    needsReview: boolean;
    source: "hardcoded" | "cache" | "llm" | "llm_uncertain" | "no_payee";
  }[] = [];
  const failures: { id: number; payee: string | null; error: string }[] = [];

  for (const row of rows) {
    const payee = row.payee as string | null;
    let categoryId: number | null = null;
    let needsReview = true;
    let source: "hardcoded" | "cache" | "llm" | "llm_uncertain" | "no_payee" = "no_payee";

    if (isInvestmentTransaction(row)) {
      categoryId = investmentsCategory.id;
      needsReview = false;
      source = "hardcoded";
      if (payee) {
        const { error: upsertError } = await supabase.from("merchant_categories").upsert(
          {
            payee,
            category_id: categoryId,
            confidence_source: "hardcoded",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "payee" }
        );
        if (upsertError) {
          console.error(`Failed to cache hardcoded category for payee "${payee}":`, upsertError);
        } else {
          knownCategories.set(payee, categoryId);
        }
      }
    } else if (payee) {
      const cachedCategoryId = knownCategories.get(payee);
      if (cachedCategoryId) {
        categoryId = cachedCategoryId;
        needsReview = false;
        source = "cache";
      } else {
        try {
          const match = await categorizeMerchant(payee);
          categoryId = match ? match.id : null;
          needsReview = match === null;
          source = match === null ? "llm_uncertain" : "llm";

          if (match !== null) {
            const confidenceSource = row.payment_method === "mandate" ? "mandate" : "llm";
            const { error: upsertError } = await supabase.from("merchant_categories").upsert(
              {
                payee,
                category_id: match.id,
                confidence_source: confidenceSource,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "payee" }
            );
            if (upsertError) {
              console.error(`Failed to cache category for payee "${payee}":`, upsertError);
            } else {
              knownCategories.set(payee, match.id);
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
    }
    // else: no payee and no hardcoded rule matched - leave needs_category_review=true,
    // category_id=null rather than guessing.

    const { error: updateError } = await supabase
      .from("transactions")
      .update({ category_id: categoryId, needs_category_review: needsReview })
      .eq("id", row.id);

    if (updateError) {
      console.error(`Failed to save category for transaction ${row.id}:`, updateError);
      failures.push({ id: row.id, payee, error: updateError.message });
      continue;
    }

    results.push({ id: row.id, payee, categoryId, needsReview, source });
  }

  return NextResponse.json({
    status: "OK",
    categorized: results.length,
    failed: failures.length,
    results,
    failures,
  });
}
