import { supabase } from "@/lib/supabase";
import { categorizeMerchant } from "@/lib/gemini";

const INVESTMENT_PAYEE_MARKERS = ["zerodha", "groww", "upstox", "angelone", "angel one"];

export function isInvestmentTransaction(row: {
  payment_method: string;
  note: string | null;
  payee: string | null;
}): boolean {
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

export type CategorizeSource = "hardcoded" | "cache" | "llm" | "llm_uncertain" | "no_payee";

export interface CategorizeOutcome {
  id: number;
  payee: string | null;
  categoryId: number | null;
  needsReview: boolean;
  source: CategorizeSource;
  error?: string;
}

let investmentsCategoryIdCache: number | null = null;

async function getInvestmentsCategoryId(): Promise<number> {
  if (investmentsCategoryIdCache !== null) return investmentsCategoryIdCache;
  const { data, error } = await supabase
    .from("categories")
    .select("id")
    .eq("name", "Investments")
    .single();
  if (error || !data) {
    throw new Error("Investments category not found in categories table");
  }
  investmentsCategoryIdCache = data.id;
  return data.id;
}

// Categorizes a single transaction: hardcoded investment rules first (no
// Gemma call), then the merchant_categories cache, then Gemma as a last
// resort - caching any newly-derived category for future lookups. Always
// writes the outcome (category_id + needs_category_review) back to the
// transactions row.
export async function categorizeTransaction(row: {
  id: number;
  payee: string | null;
  payment_method: string;
  note: string | null;
}): Promise<CategorizeOutcome> {
  const payee = row.payee;
  let categoryId: number | null = null;
  let needsReview = true;
  let source: CategorizeSource = "no_payee";
  let errorMsg: string | undefined;

  if (isInvestmentTransaction(row)) {
    categoryId = await getInvestmentsCategoryId();
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
      }
    }
  } else if (payee) {
    const { data: cached, error: cacheError } = await supabase
      .from("merchant_categories")
      .select("category_id")
      .eq("payee", payee)
      .maybeSingle();
    if (cacheError) {
      console.error(`Failed to check merchant_categories cache for "${payee}":`, cacheError);
    }

    if (cached?.category_id) {
      categoryId = cached.category_id;
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
          }
        }
      } catch (err) {
        console.error(`Failed to categorize transaction ${row.id} (payee: ${payee}):`, err);
        errorMsg = err instanceof Error ? err.message : "Unknown error";
        // categoryId stays null, needsReview stays true - never guessed at.
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
    return { id: row.id, payee, categoryId: null, needsReview: true, source, error: updateError.message };
  }

  return { id: row.id, payee, categoryId, needsReview, source, error: errorMsg };
}
