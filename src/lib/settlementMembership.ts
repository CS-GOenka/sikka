// Whether a transaction is actually in a group.
//
// This has been got wrong four times, always the same way, so the rule lives
// here now and every caller asks it rather than re-deriving it.
//
// The trap: ungrouping does not clear a transaction's settlement_group_id. The
// group is marked gone and everything else is left exactly in place, because
// that is what makes undo exact - so the column keeps pointing at a group that
// no longer counts. `settlement_group_id IS NOT NULL` therefore does NOT mean
// "grouped", and any check written that way silently treats released
// transactions as still spoken for. That is what stopped thirteen of them from
// being re-grouped.
import { supabase } from "@/lib/supabase";

export interface LiveMembership {
  transactionId: number;
  groupId: number;
  groupName: string;
}

interface MembershipRow {
  id: number;
  settlement_group_id: number | null;
  settlement_groups: { name: string; deleted_at: string | null } | null;
}

/**
 * Of these transactions, the ones genuinely in a LIVE group.
 *
 * Returns an empty list when none are - which is the answer callers want
 * before claiming transactions for a group.
 */
export async function findLiveMemberships(transactionIds: number[]): Promise<LiveMembership[]> {
  if (transactionIds.length === 0) return [];
  const { data, error } = await supabase
    .from("transactions")
    .select("id, settlement_group_id, settlement_groups(name, deleted_at)")
    .in("id", transactionIds)
    .not("settlement_group_id", "is", null)
    .returns<MembershipRow[]>();
  if (error) throw new Error(error.message);

  const out: LiveMembership[] = [];
  for (const row of data ?? []) {
    // A group that has been ungrouped is not a group. Its transactions are
    // free, whatever the column still says.
    if (!row.settlement_groups || row.settlement_groups.deleted_at !== null) continue;
    out.push({
      transactionId: row.id,
      groupId: row.settlement_group_id as number,
      groupName: row.settlement_groups.name,
    });
  }
  return out;
}

/** The live group one transaction belongs to, or null. */
export async function findLiveMembership(transactionId: number): Promise<LiveMembership | null> {
  const [found] = await findLiveMemberships([transactionId]);
  return found ?? null;
}

/**
 * The ungrouped groups these transactions are still pointing at.
 *
 * Read BEFORE claiming them for a new group: once the column is overwritten the
 * old link is gone, and with it any chance of noticing that an undo can no
 * longer be honoured in full.
 */
export async function findDeadGroupLinks(transactionIds: number[]): Promise<number[]> {
  if (transactionIds.length === 0) return [];
  const { data, error } = await supabase
    .from("transactions")
    .select("id, settlement_group_id, settlement_groups(deleted_at)")
    .in("id", transactionIds)
    .not("settlement_group_id", "is", null)
    .returns<{ id: number; settlement_group_id: number; settlement_groups: { deleted_at: string | null } | null }[]>();
  if (error) {
    console.error("Failed to read prior group links:", error.message);
    return [];
  }
  const dead = new Set<number>();
  for (const row of data ?? []) {
    if (row.settlement_groups?.deleted_at) dead.add(row.settlement_group_id);
  }
  return [...dead];
}
