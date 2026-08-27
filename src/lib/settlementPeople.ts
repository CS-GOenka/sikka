// People who have appeared in a settlement.
//
// Kept so that a regular can be added with one tap. Names are matched
// case-insensitively - "asha" and "Asha" are one person - so re-using an
// existing name bumps its count rather than accumulating near-duplicates that
// would then compete for the same quick-pick slot.
import { supabase } from "@/lib/supabase";

/** How many quick-pick pills the config box shows. */
export const QUICK_PICK_COUNT = 5;

export interface SettlementPerson {
  id: number;
  name: string;
  useCount: number;
}

interface PersonRow {
  id: number;
  name: string;
  use_count: number;
}

/**
 * Records each name used, creating it or bumping its count.
 *
 * Reads the existing rows first and matches on lowercase, because the unique
 * index is on lower(name) and an upsert cannot target a functional index. The
 * stored spelling is left as it was first entered rather than being
 * overwritten by whatever case was typed this time.
 */
export async function rememberPeople(names: string[]): Promise<void> {
  const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean).map((n) => [n.toLowerCase(), n] as const))];
  if (wanted.length === 0) return;

  const { data: existing, error } = await supabase
    .from("settlement_people").select("id, name, use_count").returns<PersonRow[]>();
  if (error) {
    console.error("Failed to read settlement people:", error.message);
    return;
  }
  const byLower = new Map((existing ?? []).map((p) => [p.name.trim().toLowerCase(), p]));

  for (const [lower, original] of wanted) {
    const match = byLower.get(lower);
    if (match) {
      const { error: upErr } = await supabase
        .from("settlement_people")
        .update({ use_count: match.use_count + 1, last_used_at: new Date().toISOString() })
        .eq("id", match.id);
      if (upErr) console.error(`Failed to bump person ${match.name}:`, upErr.message);
    } else {
      const { error: insErr } = await supabase.from("settlement_people").insert({ name: original });
      // A race could have created it between the read and here; the unique
      // index makes that a duplicate-key error, which is the right outcome and
      // not worth retrying.
      if (insErr && insErr.code !== "23505") {
        console.error(`Failed to remember person ${original}:`, insErr.message);
      }
    }
  }
}

/** The most-used names, for the quick-pick pills. */
export async function fetchFrequentPeople(limit = QUICK_PICK_COUNT): Promise<SettlementPerson[]> {
  const { data, error } = await supabase
    .from("settlement_people")
    .select("id, name, use_count")
    // Ties broken by recency, so two equally-used names do not swap places
    // between renders.
    .order("use_count", { ascending: false })
    .order("last_used_at", { ascending: false })
    .limit(limit)
    .returns<PersonRow[]>();
  if (error) {
    console.error("Failed to load frequent people:", error.message);
    return [];
  }
  return (data ?? []).map((p) => ({ id: p.id, name: p.name, useCount: p.use_count }));
}
