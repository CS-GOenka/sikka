import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recomputeGroupStatus } from "@/lib/settlementData";
import { retireUngroupUndoFor } from "@/lib/settlementUndo";
import { findDeadGroupLinks, findLiveMembership, findLiveMemberships } from "@/lib/settlementMembership";

// Adding a transaction to an existing group, and taking one out.
//
// Nothing downstream needs recalculating by hand. Every derived figure - the
// group's net, whether that net counts as spend at all, the category the spend
// is filed under, the reconciliation warning - is computed from the group's
// current transactions each time it is read. Changing the membership therefore
// changes all of them at once, which is exactly why none of them is stored.

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
  const groupId = (body as { groupId?: unknown })?.groupId;
  const transactionIds = (body as { transactionIds?: unknown })?.transactionIds;
  if (typeof groupId !== "number" || !Number.isInteger(groupId)) return bad("Expected an integer 'groupId'");
  if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
    return bad("Expected a non-empty 'transactionIds' array");
  }
  if (transactionIds.some((id) => typeof id !== "number" || !Number.isInteger(id))) {
    return bad("'transactionIds' must all be integers");
  }

  const { data: group, error: groupError } = await supabase
    .from("settlement_groups").select("id").eq("id", groupId).maybeSingle();
  if (groupError) return bad(groupError.message, 500);
  if (!group) return bad("That group no longer exists", 404);

  // A transaction belongs to at most one LIVE group, so claiming one that is
  // already spoken for would silently change the other group's net. A
  // transaction released by an ungroup is free regardless of what its
  // settlement_group_id still says.
  let clash;
  try {
    clash = (await findLiveMemberships(transactionIds as number[])).filter((t) => t.groupId !== groupId);
  } catch (err) {
    return bad(err instanceof Error ? err.message : "Could not check group membership", 500);
  }
  if (clash.length > 0) {
    const names = [...new Set(clash.map((t) => t.groupName))].join(", ");
    return bad(`${clash.length} of these are already in "${names}"`);
  }

  // Read before the claim overwrites it: a transaction still pointing at an
  // ungrouped group is the only evidence that group's undo can still be
  // honoured in full.
  const deadLinks = await findDeadGroupLinks(transactionIds as number[]);

  const { error } = await supabase
    .from("transactions").update({ settlement_group_id: groupId }).in("id", transactionIds);
  if (error) return bad(error.message, 500);
  await retireUngroupUndoFor(deadLinks);

  return NextResponse.json({ status: "OK" });
}

export async function DELETE(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Request body must be valid JSON");
  }
  const transactionId = (body as { transactionId?: unknown })?.transactionId;
  if (typeof transactionId !== "number" || !Number.isInteger(transactionId)) {
    return bad("Expected an integer 'transactionId'");
  }

  // Only a LIVE membership can be removed. A stale id left behind by an
  // ungroup is not a membership, and "removing" it would report success for
  // something that had already happened.
  let membership;
  try {
    membership = await findLiveMembership(transactionId);
  } catch (err) {
    return bad(err instanceof Error ? err.message : "Could not check group membership", 500);
  }
  if (!membership) return bad("That transaction is not in a group");
  const groupId = membership.groupId;

  // Releasing it, not deleting it: it goes back to counting individually under
  // its own original category, and loses its grouped badge.
  const { error } = await supabase
    .from("transactions").update({ settlement_group_id: null }).eq("id", transactionId);
  if (error) return bad(error.message, 500);

  // Membership does not change line status, but recomputing costs one query and
  // keeps the single writer of that column the only thing that sets it.
  await recomputeGroupStatus(groupId);
  return NextResponse.json({ status: "OK", groupId });
}
