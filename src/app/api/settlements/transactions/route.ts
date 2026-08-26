import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recomputeGroupStatus } from "@/lib/settlementData";

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

  // A transaction belongs to at most one group, so claiming one that is already
  // spoken for would silently change the other group's net.
  const { data: taken, error: takenError } = await supabase
    .from("transactions").select("id, settlement_group_id").in("id", transactionIds)
    .not("settlement_group_id", "is", null)
    .returns<{ id: number; settlement_group_id: number }[]>();
  if (takenError) return bad(takenError.message, 500);
  const clash = (taken ?? []).filter((t) => t.settlement_group_id !== groupId);
  if (clash.length > 0) return bad(`Already in another group: transaction ${clash.map((t) => t.id).join(", ")}`);

  const { error } = await supabase
    .from("transactions").update({ settlement_group_id: groupId }).in("id", transactionIds);
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
  const transactionId = (body as { transactionId?: unknown })?.transactionId;
  if (typeof transactionId !== "number" || !Number.isInteger(transactionId)) {
    return bad("Expected an integer 'transactionId'");
  }

  const { data: txn, error: readError } = await supabase
    .from("transactions").select("id, settlement_group_id").eq("id", transactionId)
    .maybeSingle<{ id: number; settlement_group_id: number | null }>();
  if (readError) return bad(readError.message, 500);
  if (!txn) return bad("That transaction no longer exists", 404);
  if (txn.settlement_group_id === null) return bad("That transaction is not in a group");
  const groupId = txn.settlement_group_id;

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
