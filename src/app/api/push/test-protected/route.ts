import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cronAuth";
import { sendPushToAll } from "@/lib/push";

// TEMPORARY - delete once push delivery has been confirmed on the phone.
//
// Fires a test notification through the exact same sendPushToAll path the
// heartbeat and budget alerts use, so a success here really does prove those
// alerts can reach the device: same VAPID keys, same subscription rows, same
// service worker handler. Only the payload differs.
//
// Protected with the shared CRON_SECRET gate because an open push endpoint is
// a notification-spam button for anyone who learns the URL. (The pre-existing
// /api/push/test is unprotected - see the note in the report.)
//
// GET and POST both work. Note that the bearer header is required either way,
// so this cannot be fired by pasting the URL into a phone browser - use curl,
// a one-off cron-job.org run, or a Shortcut that sets the header.
export const maxDuration = 30;

async function handle(request: NextRequest): Promise<NextResponse> {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    const result = await sendPushToAll({
      title: "Sikka test — push is working",
      body: "Sent from the protected test endpoint. Delivery path is healthy.",
      tag: "sikka-test-protected",
      url: "/capture-check",
    });
    // `sent` is how many subscriptions the push service accepted; `removed` is
    // dead endpoints pruned. sent === 0 with no error means there are no live
    // subscriptions - the push "succeeded" while reaching nobody, which is
    // worth surfacing rather than reporting as a bare OK.
    return NextResponse.json({
      status: "OK",
      ...result,
      note:
        result.sent === 0
          ? "No live subscriptions - nothing was delivered. Re-subscribe from /settings on the phone."
          : `Accepted by the push service for ${result.sent} device(s). If nothing arrives, the issue is on the device (notification permission, Home Screen install, or Focus mode).`,
    });
  } catch (err) {
    console.error("Protected test push failed:", err);
    return NextResponse.json(
      { status: "ERROR", error: err instanceof Error ? err.message : "Failed to send test push" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
