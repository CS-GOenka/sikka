import { supabase } from "@/lib/supabase";
import { fetchSettlementGroups } from "@/lib/settlementData";
import { fetchFrequentPeople } from "@/lib/settlementPeople";
import { deriveAssignableCategories } from "@/lib/gemini";
import { formatInr } from "@/lib/formatInr";
import type { SettlementGroup } from "@/lib/settlement";
import type { CategoryOption } from "@/lib/gemini";

export interface GroupsPageData {
  groups: SettlementGroup[];
  categories: CategoryOption[];
  /** Payee per transaction id - the settlement query does not carry it. */
  payees: Map<number, string | null>;
  categoryNames: Map<number, string>;
  /** Ungrouped transactions the editor can offer to add. */
  candidates: { id: number; label: string }[];
  knownPeople: string[];
}

/**
 * Everything the groups list and a single group's screen both need.
 *
 * Shared so the two cannot drift: a group has to describe itself the same way
 * whether it is one row among many or the whole screen. Loaded in two waves
 * rather than a chain - only the candidate and payee lookups depend on knowing
 * which groups exist.
 */
export async function fetchGroupsPageData(): Promise<GroupsPageData> {
  const [groups, categoryRows, frequentPeople] = await Promise.all([
    fetchSettlementGroups(),
    supabase.from("categories").select("id, name, parent_id")
      .returns<{ id: number; name: string; parent_id: number | null }[]>(),
    fetchFrequentPeople(50),
  ]);

  const categoryNames = new Map<number, string>();
  for (const c of categoryRows.data ?? []) categoryNames.set(c.id, c.name);

  const ids = groups.flatMap((g) => g.transactions.map((t) => t.id));
  const liveIds = new Set(groups.map((g) => g.id));

  const [payeeRows, freeRows] = await Promise.all([
    ids.length > 0
      ? supabase.from("transactions").select("id, payee").in("id", ids)
          .returns<{ id: number; payee: string | null }[]>()
      : Promise.resolve({ data: [] as { id: number; payee: string | null }[] }),
    // Recent only - a dropdown of three thousand is not a chooser.
    supabase.from("transactions")
      .select("id, payee, amount, type, transaction_date, settlement_group_id")
      .eq("status", "success").eq("currency", "INR")
      .order("id", { ascending: false }).limit(120)
      .returns<{
        id: number; payee: string | null; amount: number | null; type: string;
        transaction_date: string | null; settlement_group_id: number | null;
      }[]>(),
  ]);

  const payees = new Map<number, string | null>();
  for (const t of payeeRows.data ?? []) payees.set(t.id, t.payee);

  // "No LIVE group" rather than "no group": a transaction released by an
  // ungroup keeps its group id, since nothing is destroyed, so filtering on
  // that column alone would go on treating it as spoken for.
  const candidates = (freeRows.data ?? [])
    .filter((t) => t.settlement_group_id === null || !liveIds.has(t.settlement_group_id))
    .slice(0, 60)
    .map((t) => ({
      id: t.id,
      label: `${t.transaction_date ?? ""} ${t.type === "credit" ? "+" : "−"}${formatInr(t.amount ?? 0)} ${t.payee ?? ""}`.trim(),
    }));

  return {
    groups,
    categories: deriveAssignableCategories(categoryRows.data ?? []),
    payees,
    categoryNames,
    candidates,
    knownPeople: frequentPeople.map((p) => p.name),
  };
}
