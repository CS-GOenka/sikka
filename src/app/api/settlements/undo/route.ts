import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recomputeGroupStatus } from "@/lib/settlementData";

// Reversing the last settlement action.
//
// Each branch is the exact inverse of the write that recorded it, and none of
// them reconstructs anything: an ungroup is undone by clearing the timestamp
// that hid the group, and a settle by flipping the line back and recomputing
// the group's status from its lines the same way every other write does. The
// spend total, the owed total and the sign-rule outcome are all derived from
// that state on read, so putting the state back puts every number back with it.

function bad(error: string, status = 400) {
  return NextResponse.json({ status: "ERROR", error }, { status });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Request body must be valid JSON");
  }
  const id = (body as { id?: unknown })?.id;
  if (typeof id !== "number" || !Number.isInteger(id)) return bad("Expected an integer 'id'");

  const { data: entry, error: readError } = await supabase
    .from("settlement_undo")
    .select("id, action, group_id, line_id, undone_at")
    .eq("id", id)
    .maybeSingle<{
      id: number;
      action: "ungroup" | "settle" | "unsettle";
      group_id: number | null;
      line_id: number | null;
      undone_at: string | null;
    }>();
  if (readError) return bad(readError.message, 500);
  if (!entry) return bad("That action is no longer undoable", 404);
  // Marked undone before anything else runs, so a double tap cannot apply the
  // same reversal twice.
  if (entry.undone_at) return NextResponse.json({ status: "OK", alreadyUndone: true });

  if (entry.action === "ungroup") {
    if (entry.group_id === null) return bad("That action has no group to restore");
    // Everything was left in place, so the group returns with its own id, its
    // category, its lines and its transactions still attached.
    const { error } = await supabase
      .from("settlement_groups").update({ deleted_at: null }).eq("id", entry.group_id);
    if (error) return bad(error.message, 500);
    // Its status still follows its lines, which may have changed meanwhile.
    await recomputeGroupStatus(entry.group_id);
  } else {
    if (entry.line_id === null) return bad("That action has no line to restore");
    // "settle" is undone by reopening, "unsettle" by settling again.
    const restoreTo = entry.action === "settle" ? "open" : "settled";
    const { data: line, error: lineError } = await supabase
      .from("settlement_lines")
      .update({
        status: restoreTo,
        settled_at: restoreTo === "settled" ? new Date().toISOString() : null,
      })
      .eq("id", entry.line_id)
      .select("group_id")
      .maybeSingle<{ group_id: number }>();
    if (lineError) return bad(lineError.message, 500);
    if (!line) return bad("That line no longer exists", 404);
    // Reopening the last settled line reopens the group; settling the last
    // open one closes it again.
    await recomputeGroupStatus(line.group_id);
  }

  const { error: markError } = await supabase
    .from("settlement_undo").update({ undone_at: new Date().toISOString() }).eq("id", id);
  if (markError) console.error("Failed to mark undo entry as used:", markError.message);
  return NextResponse.json({ status: "OK" });
}
