import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recomputeGroupStatus } from "@/lib/settlementData";
import { recordUndoable } from "@/lib/settlementUndo";
import { rememberPeople } from "@/lib/settlementPeople";

// A person's line: adding one, removing one, changing what they owe, and
// settling or un-settling it. The group's status follows every one of them,
// since a group is closed exactly when nothing is left open.

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
  if (typeof lineId !== "number" || !Number.isInteger(lineId)) return bad("Expected an integer 'lineId'");
  const hasSettled = "settled" in (body as object);
  const hasShare = "share" in (body as object);
  if (hasSettled === hasShare) return bad("Expected exactly one of 'settled' or 'share'");

  const { data: line, error: readError } = await supabase
    .from("settlement_lines").select("id, group_id, person, share, status").eq("id", lineId)
    .maybeSingle<{ id: number; group_id: number; person: string; share: number; status: "open" | "settled" }>();
  if (readError) return bad(readError.message, 500);
  if (!line) return bad("That line no longer exists", 404);

  if (hasShare) {
    const share = (body as { share?: unknown }).share;
    if (typeof share !== "number" || !Number.isFinite(share) || share < 0) {
      return bad("'share' must be a number of rupees, zero or more");
    }
    // Paise, not floating dust: 1000/3 must not reach the column as
    // 333.33333333333337 and then reappear in a total.
    const rounded = Math.round((share + Number.EPSILON) * 100) / 100;
    const previous = Number(line.share);
    if (rounded === previous) return NextResponse.json({ status: "OK", unchanged: true });

    const { error } = await supabase
      .from("settlement_lines").update({ share: rounded }).eq("id", lineId);
    if (error) return bad(error.message, 500);
    // Status is untouched on purpose: what someone owes and whether they have
    // paid are different facts, and correcting a figure is not a statement
    // about either. But a group's status is derived from its lines, so it is
    // recomputed anyway in case this line was the reason it was open.
    await recomputeGroupStatus(line.group_id);
    await recordUndoable({
      action: "share",
      groupId: line.group_id,
      lineId,
      prevValue: String(previous),
      label: `${line.person}'s share changed from ₹${previous} to ₹${rounded}`,
    });
    return NextResponse.json({ status: "OK", share: rounded, previous });
  }

  const settled = (body as { settled?: unknown }).settled;
  if (typeof settled !== "boolean") return bad("Expected a boolean 'settled'");

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

/** Adding a person to a group. */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Request body must be valid JSON");
  }
  const groupId = (body as { groupId?: unknown })?.groupId;
  const person = (body as { person?: unknown })?.person;
  const share = (body as { share?: unknown })?.share;
  if (typeof groupId !== "number" || !Number.isInteger(groupId)) return bad("Expected an integer 'groupId'");
  if (typeof person !== "string" || !person.trim()) return bad("Expected a non-empty 'person'");
  if (typeof share !== "number" || !Number.isFinite(share) || share < 0) {
    return bad("'share' must be a number of rupees, zero or more");
  }
  const name = person.trim();
  const rounded = Math.round((share + Number.EPSILON) * 100) / 100;

  const { error } = await supabase
    .from("settlement_lines")
    .insert({ group_id: groupId, person: name, share: rounded, status: "open" });
  if (error) return bad(error.message, 500);

  // A group with a new open line is open again, even if it had been closed.
  await recomputeGroupStatus(groupId);
  // Same list the group-creation flow feeds, so a name typed here is offered
  // next time rather than having to be typed again.
  await rememberPeople([name]);
  return NextResponse.json({ status: "OK" });
}

/** Removing a person from a group. Undoable - the line is gone otherwise. */
export async function DELETE(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Request body must be valid JSON");
  }
  const lineId = (body as { lineId?: unknown })?.lineId;
  if (typeof lineId !== "number" || !Number.isInteger(lineId)) return bad("Expected an integer 'lineId'");

  const { data: line, error: readError } = await supabase
    .from("settlement_lines").select("id, group_id, person, share, status").eq("id", lineId)
    .maybeSingle<{ id: number; group_id: number; person: string; share: number; status: "open" | "settled" }>();
  if (readError) return bad(readError.message, 500);
  if (!line) return bad("That line no longer exists", 404);

  // Recorded before the delete, not after: once the row is gone there is
  // nothing left to read the person or the amount off.
  await recordUndoable({
    action: "remove-person",
    groupId: line.group_id,
    lineId: null,
    prevValue: JSON.stringify({
      groupId: line.group_id, person: line.person,
      share: Number(line.share), status: line.status,
    }),
    label: `Removed ${line.person}`,
  });

  const { error } = await supabase.from("settlement_lines").delete().eq("id", lineId);
  if (error) return bad(error.message, 500);

  // Removing the last open line closes the group.
  await recomputeGroupStatus(line.group_id);
  return NextResponse.json({ status: "OK" });
}
