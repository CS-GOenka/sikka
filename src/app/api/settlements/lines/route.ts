import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recomputeGroupStatus } from "@/lib/settlementData";
import { recordUndoable } from "@/lib/settlementUndo";

// Settling (and un-settling) a person's line. The group's status follows.

function bad(error: string, status = 400) {
  return NextResponse.json({ status: "ERROR", error }, { status });
}

export async function PATCH(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Request body must be valid JSON");
  }

  const lineId = (body as { lineId?: unknown })?.lineId;
  const settled = (body as { settled?: unknown })?.settled;
  if (typeof lineId !== "number" || !Number.isInteger(lineId)) return bad("Expected an integer 'lineId'");
  if (typeof settled !== "boolean") return bad("Expected a boolean 'settled'");

  const { data: line, error: readError } = await supabase
    .from("settlement_lines").select("id, group_id, person, share").eq("id", lineId)
    .maybeSingle<{ id: number; group_id: number; person: string; share: number }>();
  if (readError) return bad(readError.message, 500);
  if (!line) return bad("That line no longer exists", 404);

  const { error } = await supabase
    .from("settlement_lines")
    .update({
      status: settled ? "settled" : "open",
      settled_at: settled ? new Date().toISOString() : null,
    })
    .eq("id", lineId);
  if (error) return bad(error.message, 500);

  // Settling the last open line closes the group; reopening one opens it again.
  await recomputeGroupStatus(line.group_id);

  await recordUndoable({
    action: settled ? "settle" : "unsettle",
    groupId: line.group_id,
    lineId,
    label: settled ? `Settled ${line.person}` : `Reopened ${line.person}`,
  });
  return NextResponse.json({ status: "OK" });
}
