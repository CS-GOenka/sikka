import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Stores (or refreshes) a browser's Web Push subscription. The client sends
// the raw PushSubscription JSON; we persist endpoint + the p256dh/auth
// encryption keys. endpoint is unique, so re-subscribing the same device
// upserts instead of duplicating.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse push subscribe body:", err);
    return NextResponse.json({ status: "ERROR", error: "Request body must be valid JSON" }, { status: 400 });
  }

  const sub = (body as { subscription?: unknown })?.subscription as
    | { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
    | undefined;
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;

  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
    return NextResponse.json(
      { status: "ERROR", error: "Expected subscription.endpoint and subscription.keys.{p256dh,auth}" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("push_subscriptions")
    .upsert({ endpoint, p256dh, auth }, { onConflict: "endpoint" });

  if (error) {
    console.error("Failed to save push subscription:", error);
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  return NextResponse.json({ status: "OK" });
}
