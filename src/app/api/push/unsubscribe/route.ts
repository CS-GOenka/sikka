import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Removes a stored subscription by endpoint (called when notifications are
// disabled on a device).
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse push unsubscribe body:", err);
    return NextResponse.json({ status: "ERROR", error: "Request body must be valid JSON" }, { status: 400 });
  }

  const endpoint = (body as { endpoint?: unknown })?.endpoint;
  if (typeof endpoint !== "string") {
    return NextResponse.json({ status: "ERROR", error: "Expected a string 'endpoint' field" }, { status: 400 });
  }

  const { error } = await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) {
    console.error("Failed to delete push subscription:", error);
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  return NextResponse.json({ status: "OK" });
}
