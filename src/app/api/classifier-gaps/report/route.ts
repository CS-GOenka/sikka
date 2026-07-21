import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Reporting a suspected classifier gap removes the row from the active
// /review queue (it's excluded there whenever classifier_gap_reported is
// true) but does NOT resolve it the way recategorizing does - needs_
// category_review/starred are left untouched, since the underlying data is
// still considered untrustworthy until the batch fix actually lands.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse classifier gap report body:", err);
    return NextResponse.json(
      { status: "ERROR", error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  const transactionId = (body as { transactionId?: unknown })?.transactionId;
  const comment = (body as { comment?: unknown })?.comment;

  if (typeof transactionId !== "number") {
    return NextResponse.json(
      { status: "ERROR", error: "Expected a numeric 'transactionId' field" },
      { status: 400 }
    );
  }
  if (comment !== undefined && comment !== null && typeof comment !== "string") {
    return NextResponse.json(
      { status: "ERROR", error: "'comment' must be a string if provided" },
      { status: 400 }
    );
  }

  const trimmedComment = typeof comment === "string" && comment.trim().length > 0 ? comment.trim() : null;

  const { error } = await supabase
    .from("transactions")
    .update({ classifier_gap_reported: true, classifier_gap_comment: trimmedComment })
    .eq("id", transactionId);

  if (error) {
    console.error(`Failed to report classifier gap for transaction ${transactionId}:`, error);
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  return NextResponse.json({ status: "OK", transactionId, comment: trimmedComment });
}
