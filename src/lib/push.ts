import webpush from "web-push";
import { supabase } from "@/lib/supabase";

// VAPID identity. The public key is also exposed to the client (as
// NEXT_PUBLIC_VAPID_PUBLIC_KEY) for PushManager.subscribe(); the private key
// is server-only. Configured lazily so importing this module never throws at
// build time if the env isn't set yet.
const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;
const subject = process.env.VAPID_SUBJECT ?? "mailto:admin@sikka.app";

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (!publicKey || !privateKey) {
    throw new Error("Missing NEXT_PUBLIC_VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY environment variable");
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

export interface PushPayload {
  title: string;
  body: string;
  // Where to navigate when the notification is tapped (handled in sw.js).
  url?: string;
  // Collapse key: a later notification with the same tag replaces an earlier
  // one instead of stacking.
  tag?: string;
}

export interface PushResult {
  sent: number;
  removed: number;
  failures: number;
}

// Sends a payload to every stored subscription. Dead endpoints (404/410) are
// pruned so they don't keep failing forever; other failures are logged but
// don't abort the rest of the fan-out.
export async function sendPushToAll(payload: PushPayload): Promise<PushResult> {
  ensureConfigured();

  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth");
  if (error) {
    throw new Error(`Failed to load push subscriptions: ${error.message}`);
  }
  if (!subs || subs.length === 0) {
    return { sent: 0, removed: 0, failures: 0 };
  }

  const json = JSON.stringify(payload);
  let sent = 0;
  let failures = 0;
  const staleIds: number[] = [];

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          json
        );
        sent += 1;
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          staleIds.push(s.id);
        } else {
          console.error(`Push send failed for subscription ${s.id}:`, err);
          failures += 1;
        }
      }
    })
  );

  if (staleIds.length > 0) {
    const { error: delErr } = await supabase.from("push_subscriptions").delete().in("id", staleIds);
    if (delErr) console.error("Failed to prune stale push subscriptions:", delErr);
  }

  return { sent, removed: staleIds.length, failures };
}
