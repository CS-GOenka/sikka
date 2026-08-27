// The last reversible settlement action.
//
// Undo here is not a UI affordance layered over a completed change - it is the
// change itself being reversible, because nothing any of these actions does is
// destructive:
//
//   ungroup   marks the group gone and leaves the row, its lines and its
//             transactions' membership untouched, so reversing is clearing one
//             timestamp
//   settle    flips a line's status, and the group's own status is derived
//             from its lines rather than stored independently, so reversing
//             the line and recomputing puts both back
//
// That is why this journal records only which action touched which row. It
// holds no copy of the previous values: a second record of the prior state
// could disagree with the first, and then "undo" would restore something that
// was never true.
import { supabase } from "@/lib/supabase";

/** How long the offer stands. Long enough to notice a mistake, not a history feature. */
export const UNDO_WINDOW_MS = 10 * 60 * 1000;

export type UndoAction = "ungroup" | "settle" | "unsettle";

export interface UndoEntry {
  id: number;
  action: UndoAction;
  groupId: number | null;
  lineId: number | null;
  label: string;
  createdAt: string;
}

interface UndoRow {
  id: number;
  action: UndoAction;
  group_id: number | null;
  line_id: number | null;
  label: string;
  created_at: string;
}

export async function recordUndoable(input: {
  action: UndoAction;
  groupId?: number | null;
  lineId?: number | null;
  label: string;
}): Promise<void> {
  const { error } = await supabase.from("settlement_undo").insert({
    action: input.action,
    group_id: input.groupId ?? null,
    line_id: input.lineId ?? null,
    label: input.label,
  });
  // Best effort: failing to record an undo must not fail the action itself.
  if (error) console.error("Failed to record undoable action:", error.message);
}

/**
 * The single most recent action still offerable.
 *
 * One at a time on purpose. A stack of undos would let them be applied out of
 * order - reversing an ungroup after a line inside it had been settled, say -
 * and each would then be restoring a state that no longer exists.
 */
export async function fetchLastUndoable(nowMs: number = Date.now()): Promise<UndoEntry | null> {
  const since = new Date(nowMs - UNDO_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("settlement_undo")
    .select("id, action, group_id, line_id, label, created_at")
    .is("undone_at", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .returns<UndoRow[]>();
  if (error) {
    console.error("Failed to load undoable actions:", error.message);
    return null;
  }
  const row = data?.[0];
  if (!row) return null;
  return {
    id: row.id,
    action: row.action,
    groupId: row.group_id,
    lineId: row.line_id,
    label: row.label,
    createdAt: row.created_at,
  };
}
