import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Answering a refused share: capture it after all, or agree it was a duplicate.

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
  const action = (body as { action?: unknown })?.action;
  if (typeof id !== "number" || !Number.isInteger(id)) return bad("Expected an integer 'id'");
  if (action !== "capture" && action !== "duplicate") {
    return bad("'action' must be 'capture' or 'duplicate'");
  }

  const { data: rejection, error: readError } = await supabase
    .from("rejected_captures").select("id, message, resolved_at").eq("id", id)
    .maybeSingle<{ id: number; message: string; resolved_at: string | null }>();
  if (readError) return bad(readError.message, 500);
  if (!rejection) return bad("That rejection no longer exists", 404);
  if (rejection.resolved_at) return NextResponse.json({ status: "OK", alreadyResolved: true });

  if (action === "capture") {
    // Re-ingest the exact text with every duplicate check bypassed. Resolving
    // the rejection only after this succeeds means a failure cannot leave the
    // callout claiming a transaction was captured when it was not.
    const origin = new URL(request.url).origin;
    const res = await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // force: the duplicate check already refused this once and would refuse
      // it again on the same evidence. The user has overruled it.
      body: JSON.stringify({ message: rejection.message, force: true }),
    });
    if (!res.ok) return bad("Could not capture that transaction", 500);
  }

  const { error } = await supabase
    .from("rejected_captures")
    .update({ resolved_at: new Date().toISOString(), resolution: action === "capture" ? "captured" : "duplicate" })
    .eq("id", id);
  if (error) return bad(error.message, 500);
  return NextResponse.json({ status: "OK" });
}
