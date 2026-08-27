import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recomputeGroupStatus } from "@/lib/settlementData";
import { recordUndoable, retireUngroupUndoFor } from "@/lib/settlementUndo";
import { rememberPeople } from "@/lib/settlementPeople";
import { findDeadGroupLinks, findLiveMemberships } from "@/lib/settlementMembership";

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
  const rawCategoryId = (body as { categoryId?: unknown })?.categoryId;
  const categoryId =
    rawCategoryId === null || rawCategoryId === undefined
      ? null
      : typeof rawCategoryId === "number" && Number.isInteger(rawCategoryId)
        ? rawCategoryId
        : NaN;
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
  if (Number.isNaN(categoryId)) return bad("'categoryId' must be an integer or null");

  // A transaction belongs to at most one LIVE group. Claiming one that is
  // already spoken for would silently move it out of the group whose total
  // depends on it - but a transaction released by an ungroup is free, however
  // its settlement_group_id still reads.
  let taken;
  try {
    taken = await findLiveMemberships(transactionIds as number[]);
  } catch (err) {
    return bad(err instanceof Error ? err.message : "Could not check group membership", 500);
  }
  if (taken.length > 0) {
    const names = [...new Set(taken.map((t) => t.groupName))].join(", ");
    return bad(`${taken.length} of these are already in "${names}"`);
  }

  const { data: group, error: groupError } = await supabase
    .from("settlement_groups")
    .insert({ name: name.trim(), category_id: categoryId })
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

  // Read before the claim overwrites it: a transaction still pointing at an
  // ungrouped group is the only evidence that group's undo can still be
  // honoured in full.
  const deadLinks = await findDeadGroupLinks(transactionIds as number[]);

  const { error: tagError } = await supabase
    .from("transactions")
    .update({ settlement_group_id: group.id })
    .in("id", transactionIds);
  if (tagError) {
    await supabase.from("settlement_groups").delete().eq("id", group.id);
    return bad(tagError.message, 500);
  }

  await retireUngroupUndoFor(deadLinks);

  // Every name used is remembered, so a regular can be added with one tap next
  // time. Matched case-insensitively, so this reuses a stored name rather than
  // accumulating near-duplicates.
  if (lines.length > 0) await rememberPeople(lines.map((l) => l.person));

  // A group with no lines has nothing outstanding, so it is born closed.
  await recomputeGroupStatus(group.id);
  return NextResponse.json({ status: "OK", groupId: group.id });
}

// Re-categorising a group, or renaming it. The parent's category is what the
// pie and every analytic see for this group's spend, so it has to be
// changeable after the fact.
export async function PATCH(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Request body must be valid JSON");
  }
  const groupId = (body as { groupId?: unknown })?.groupId;
  if (typeof groupId !== "number" || !Number.isInteger(groupId)) return bad("Expected an integer 'groupId'");

  const patch: { category_id?: number | null; name?: string } = {};
  if ("categoryId" in (body as object)) {
    const raw = (body as { categoryId?: unknown }).categoryId;
    if (raw !== null && (typeof raw !== "number" || !Number.isInteger(raw))) {
      return bad("'categoryId' must be an integer or null");
    }
    patch.category_id = raw as number | null;
  }
  if ("name" in (body as object)) {
    const raw = (body as { name?: unknown }).name;
    if (typeof raw !== "string" || !raw.trim()) return bad("'name' must be a non-empty string");
    patch.name = raw.trim();
  }
  if (Object.keys(patch).length === 0) return bad("Nothing to update");

  const { error } = await supabase.from("settlement_groups").update(patch).eq("id", groupId);
  if (error) return bad(error.message, 500);
  return NextResponse.json({ status: "OK" });
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

  const { data: group, error: readError } = await supabase
    .from("settlement_groups").select("id, name").eq("id", groupId)
    .maybeSingle<{ id: number; name: string }>();
  if (readError) return bad(readError.message, 500);
  if (!group) return bad("That group no longer exists", 404);

  // Marked gone rather than deleted. The row, its lines and its transactions'
  // membership all stay exactly as they are, so undoing this is clearing one
  // timestamp - nothing to rebuild, and nothing that can come back subtly
  // different. Everything downstream reads live groups only, so the
  // transactions go straight back to counting on their own.
  const { error } = await supabase
    .from("settlement_groups")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", groupId);
  if (error) return bad(error.message, 500);

  await recordUndoable({ action: "ungroup", groupId, label: `Ungrouped "${group.name}"` });
  return NextResponse.json({ status: "OK" });
}
