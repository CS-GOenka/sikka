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

// Own-name transfers between the account holder's own accounts - never
// real spend, regardless of category.
const SELF_TRANSFER_NAMES = ["saurabh goenka"];

export function isSelfTransfer(payee: string | null): boolean {
  if (!payee) return false;
  return SELF_TRANSFER_NAMES.includes(payee.trim().toLowerCase());
}

export type CategorizeSource =
  | "hardcoded"
  | "cache"
  | "llm"
  | "llm_uncertain"
  | "llm_p2p_unconfirmed"
  | "person_match_unconfirmed"
  | "no_payee";

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

let personToPersonCategoryIdsCache: Set<number> | null = null;

// Person-to-Person and all of its children (e.g. "Friends and Family") -
// the category an LLM guess defaults to most often without real evidence,
// per the merchant_categories cache audit.
async function getPersonToPersonCategoryIds(): Promise<Set<number>> {
  if (personToPersonCategoryIdsCache !== null) return personToPersonCategoryIdsCache;
  const { data: parent, error: parentError } = await supabase
    .from("categories")
    .select("id")
    .eq("name", "Person-to-Person")
    .single();
  if (parentError || !parent) {
    throw new Error("Person-to-Person category not found in categories table");
  }
  const { data: children } = await supabase.from("categories").select("id").eq("parent_id", parent.id);
  const ids = new Set<number>([parent.id, ...(children ?? []).map((c) => c.id)]);
  personToPersonCategoryIdsCache = ids;
  return ids;
}

function nameWords(s: string): string[] {
  return s.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// Different rails truncate the same person's name differently - a UPI transfer
// carries "SUBHAM GOENKA" while a NEFT reference carries only "SUBHAM". The
// merchant_categories cache is keyed on the exact string, so a manual
// "Subham Goenka -> Family" doesn't cover a later "Subham", which then falls to
// the LLM and gets a Friends/Family coin-flip. This links them: if the payee is
// a strict leading-name form of exactly one *manually-confirmed* Person-to-
// Person entry (or vice-versa), inherit that category. Requires an unambiguous
// single match so two different same-first-name people can't collide.
async function findManualPersonMatch(payee: string, p2pIds: Set<number>): Promise<number | null> {
  const target = nameWords(payee);
  if (target.length === 0) return null;

  const { data, error } = await supabase
    .from("merchant_categories")
    .select("payee, category_id")
    .eq("confidence_source", "manual");
  if (error || !data) return null;

  const matchedCategories = new Set<number>();
  for (const row of data) {
    if (!p2pIds.has(row.category_id)) continue;
    const words = nameWords(row.payee);
    // Directional: only inherit when `payee` is a strict leading truncation of
    // a fuller confirmed name (e.g. "Subham" -> "Subham Goenka"). The reverse
    // must NOT match - a fuller new name like "Subham Verma" must never inherit
    // a bare "Subham" entry, since it could be a different person.
    if (target.length < words.length && target.every((w, i) => w === words[i])) {
      matchedCategories.add(row.category_id);
    }
  }
  return matchedCategories.size === 1 ? [...matchedCategories][0] : null;
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

  if (isSelfTransfer(payee)) {
    const { error: updateError } = await supabase
      .from("transactions")
      .update({ category_id: null, needs_category_review: false, is_transfer: true })
      .eq("id", row.id);
    if (updateError) {
      console.error(`Failed to mark self-transfer for transaction ${row.id}:`, updateError);
      return { id: row.id, payee, categoryId: null, needsReview: true, source: "hardcoded", error: updateError.message };
    }
    return { id: row.id, payee, categoryId: null, needsReview: false, source: "hardcoded" };
  }

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

    const p2pIds = await getPersonToPersonCategoryIds();
    const personMatch = cached?.category_id ? null : await findManualPersonMatch(payee, p2pIds);

    if (cached?.category_id) {
      categoryId = cached.category_id;
      needsReview = false;
      source = "cache";
    } else if (personMatch !== null) {
      // Same person as an existing manually-confirmed P2P entry, matched by a
      // truncated name (e.g. NEFT "Subham" vs UPI-confirmed "Subham Goenka").
      // Inherit that category instead of letting the LLM coin-flip Friends vs
      // Family, but keep needs_review=true and don't cache under this string -
      // it surfaces once to confirm the link, then normal caching takes over.
      categoryId = personMatch;
      needsReview = true;
      source = "person_match_unconfirmed";
    } else {
      try {
        const match = await categorizeMerchant(payee);

        if (match !== null && p2pIds.has(match.id)) {
          // Person-to-Person is where a truncated or ambiguous business
          // name most often gets defaulted to without real evidence (per
          // the merchant_categories cache audit). Assign it as a tentative
          // answer so the transaction isn't left blank, but never cache
          // it - surfaces once in /review for a one-time human decision.
          // Once manually confirmed there, normal caching takes over and
          // this exact payee is never asked about again.
          categoryId = match.id;
          needsReview = true;
          source = "llm_p2p_unconfirmed";
        } else {
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

  // One retry on the final write: under high request volume (e.g. a bulk
  // load) this update has been observed to fail transiently, which used to
  // leave the row silently stuck at its insert-time defaults - uncategorized
  // and, worse, invisible in /review. needs_category_review now also
  // defaults to true at the DB level as a second layer of defense, but a
  // retry means most transient failures never need that fallback at all.
  let updateError = (await supabase.from("transactions").update({ category_id: categoryId, needs_category_review: needsReview }).eq("id", row.id)).error;
  if (updateError) {
    console.error(`Failed to save category for transaction ${row.id}, retrying once:`, updateError);
    updateError = (await supabase.from("transactions").update({ category_id: categoryId, needs_category_review: needsReview }).eq("id", row.id)).error;
  }

  if (updateError) {
    console.error(`Failed to save category for transaction ${row.id} after retry:`, updateError);
    return { id: row.id, payee, categoryId: null, needsReview: true, source, error: updateError.message };
  }

  return { id: row.id, payee, categoryId, needsReview, source, error: errorMsg };
}
