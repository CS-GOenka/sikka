// Loading settlement groups, and turning them into spend.
//
// Kept apart from settlement.ts so the arithmetic there stays importable
// without a database, in the same shape as receivedAt.ts / duplicateCheck.ts.
import { supabase } from "@/lib/supabase";
import {
  deriveStatus, groupAnchor, groupCategory, groupNet, groupOwed,
  groupSpendContribution, type SettlementGroup,
} from "@/lib/settlement";

interface GroupRow {
  id: number;
  name: string;
  status: "open" | "closed";
  created_at: string;
  settlement_lines: { id: number; person: string; share: number; status: "open" | "settled" }[];
  transactions: {
    id: number; type: string; status: string | null; currency: string;
    amount: number | null; category_id: number | null;
    raw_messages: { phone_received_at: string | null } | null;
  }[];
}

const SELECT =
  "id, name, status, created_at, " +
  "settlement_lines(id, person, share, status), " +
  "transactions(id, type, status, currency, amount, category_id, raw_messages(phone_received_at))";

function toGroup(row: GroupRow): SettlementGroup {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    lines: (row.settlement_lines ?? []).map((l) => ({
      id: l.id, person: l.person, share: Number(l.share), status: l.status,
    })),
    transactions: (row.transactions ?? []).map((t) => ({
      id: t.id, type: t.type, status: t.status, currency: t.currency,
      amount: t.amount === null ? null : Number(t.amount),
      categoryId: t.category_id,
      receivedAt: t.raw_messages?.phone_received_at ?? null,
    })),
  };
}

/**
 * Every group, with its transactions and lines.
 *
 * Deliberately unfiltered by date: a group's net is anchored on its earliest
 * transaction, which cannot be known without loading the group, so narrowing
 * by window here would drop groups that belong in it. This is a personal
 * ledger - the table holds a handful of rows - so the whole set is cheap.
 */
export async function fetchSettlementGroups(): Promise<SettlementGroup[]> {
  const { data, error } = await supabase.from("settlement_groups").select(SELECT).returns<GroupRow[]>();
  if (error) {
    // Never let a settlement problem take a spend total down with it: the
    // ungrouped transactions are still the bulk of the answer.
    console.error("Failed to load settlement groups:", error.message);
    return [];
  }
  return (data ?? []).map(toGroup);
}

export async function fetchSettlementGroup(id: number): Promise<SettlementGroup | null> {
  const { data, error } = await supabase
    .from("settlement_groups").select(SELECT).eq("id", id).maybeSingle<GroupRow>();
  if (error) {
    console.error(`Failed to load settlement group ${id}:`, error.message);
    return null;
  }
  return data ? toGroup(data) : null;
}

export interface GroupSpendContribution {
  groupId: number;
  name: string;
  /** The group's true net, which may be negative - for display. */
  net: number;
  /** What spend counts: the net, or zero if the group came out ahead. */
  spend: number;
  anchor: string;
  categoryId: number | null;
}

/** One figure per group that has an anchor - what spend actually sees. */
export function groupContributions(groups: SettlementGroup[]): GroupSpendContribution[] {
  const out: GroupSpendContribution[] = [];
  for (const group of groups) {
    const anchor = groupAnchor(group);
    if (!anchor) continue; // nothing dateable in it yet
    out.push({
      groupId: group.id,
      name: group.name,
      net: groupNet(group),
      spend: groupSpendContribution(group),
      anchor,
      categoryId: groupCategory(group),
    });
  }
  return out;
}

/** Total still owed to me, and how many groups it spans - the homepage card. */
export function owedSummary(groups: SettlementGroup[]): { owed: number; openGroups: number } {
  let owed = 0;
  let openGroups = 0;
  for (const group of groups) {
    const groupOwedAmount = groupOwed(group);
    if (groupOwedAmount > 0) {
      owed += groupOwedAmount;
      openGroups += 1;
    }
  }
  return { owed: Math.round((owed + Number.EPSILON) * 100) / 100, openGroups };
}

/** Rewrites a group's status from its lines. The single writer of that column. */
export async function recomputeGroupStatus(groupId: number): Promise<void> {
  const { data, error } = await supabase
    .from("settlement_lines").select("status").eq("group_id", groupId)
    .returns<{ status: "open" | "settled" }[]>();
  if (error) {
    console.error(`Failed to read lines for group ${groupId}:`, error.message);
    return;
  }
  const status = deriveStatus((data ?? []).map((l) => ({ id: 0, person: "", share: 0, status: l.status })));
  const { error: upErr } = await supabase
    .from("settlement_groups")
    .update({ status, closed_at: status === "closed" ? new Date().toISOString() : null })
    .eq("id", groupId);
  if (upErr) console.error(`Failed to update status for group ${groupId}:`, upErr.message);
}
