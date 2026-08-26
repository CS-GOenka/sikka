import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recomputeGroupStatus } from "@/lib/settlementData";

// Creating a settlement group, and deleting one.

function bad(error: string, status = 400) {
  return NextResponse.json({ status: "ERROR", error }, { status });
}

interface LineInput {
  person: string;
  share: number;
}

function parseLines(raw: unknown): LineInput[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: LineInput[] = [];
  for (const item of raw) {
    const person = (item as { person?: unknown })?.person;
    const share = (item as { share?: unknown })?.share;
    if (typeof person !== "string" || !person.trim()) return null;
    if (typeof share !== "number" || !Number.isFinite(share) || share < 0) return null;
    out.push({ person: person.trim(), share });
  }
  return out;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Request body must be valid JSON");
  }

  const name = (body as { name?: unknown })?.name;
  const transactionIds = (body as { transactionIds?: unknown })?.transactionIds;
  const lines = parseLines((body as { lines?: unknown })?.lines);

  if (typeof name !== "string" || !name.trim()) return bad("Expected a non-empty 'name'");
  if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
    return bad("Expected a non-empty 'transactionIds' array");
  }
  if (transactionIds.some((id) => typeof id !== "number" || !Number.isInteger(id))) {
    return bad("'transactionIds' must all be integers");
  }
  if (lines === null) return bad("Each line needs a non-empty 'person' and a non-negative 'share'");

  // A transaction belongs to at most one group. Claiming one that is already
  // grouped would silently move it out of the group whose total depends on it.
  const { data: taken, error: takenError } = await supabase
    .from("transactions")
    .select("id, settlement_group_id")
    .in("id", transactionIds)
    .not("settlement_group_id", "is", null)
    .returns<{ id: number; settlement_group_id: number }[]>();
  if (takenError) return bad(takenError.message, 500);
  if (taken && taken.length > 0) {
    return bad(`Already in another group: transaction ${taken.map((t) => t.id).join(", ")}`);
  }

  const { data: group, error: groupError } = await supabase
    .from("settlement_groups")
    .insert({ name: name.trim() })
    .select("id")
    .single<{ id: number }>();
  if (groupError || !group) return bad(groupError?.message ?? "Failed to create group", 500);

  if (lines.length > 0) {
    const { error: lineError } = await supabase
      .from("settlement_lines")
      .insert(lines.map((l) => ({ group_id: group.id, person: l.person, share: l.share })));
    if (lineError) {
      // Leave nothing half-made: without its lines the group's net would be
      // wrong, and wrong is worse than absent.
      await supabase.from("settlement_groups").delete().eq("id", group.id);
      return bad(lineError.message, 500);
    }
  }

  const { error: tagError } = await supabase
    .from("transactions")
    .update({ settlement_group_id: group.id })
    .in("id", transactionIds);
  if (tagError) {
    await supabase.from("settlement_groups").delete().eq("id", group.id);
    return bad(tagError.message, 500);
  }

  // A group with no lines has nothing outstanding, so it is born closed.
  await recomputeGroupStatus(group.id);
  return NextResponse.json({ status: "OK", groupId: group.id });
}

export async function DELETE(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Request body must be valid JSON");
  }
  const groupId = (body as { groupId?: unknown })?.groupId;
  if (typeof groupId !== "number" || !Number.isInteger(groupId)) {
    return bad("Expected an integer 'groupId'");
  }
  // The FK is ON DELETE SET NULL, so the transactions are released back to
  // counting individually rather than being destroyed with the group.
  const { error } = await supabase.from("settlement_groups").delete().eq("id", groupId);
  if (error) return bad(error.message, 500);
  return NextResponse.json({ status: "OK" });
}
