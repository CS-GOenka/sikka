import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Clears a classifier-gap report. Does not touch needs_category_review or
// starred - the transaction just re-enters /review if either of those is
// still true, or drops out entirely if neither is.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse classifier gap undo body:", err);
    return NextResponse.json(
      { status: "ERROR", error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  const transactionId = (body as { transactionId?: unknown })?.transactionId;
  if (typeof transactionId !== "number") {
    return NextResponse.json(
      { status: "ERROR", error: "Expected a numeric 'transactionId' field" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("transactions")
    .update({ classifier_gap_reported: false, classifier_gap_comment: null })
    .eq("id", transactionId);

  if (error) {
    console.error(`Failed to undo classifier gap report for transaction ${transactionId}:`, error);
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  return NextResponse.json({ status: "OK", transactionId });
}
