import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendPushToAll } from "@/lib/push";

// Runs off a Vercel cron (see vercel.json) - deliberately independent of the
// Mac, since the Mac (Shortcut + reconcile) is itself part of what's
// unreliable. Checks how long since the most recent transaction was captured;
// if that exceeds the threshold, it pushes an alert so a silent capture outage
// is noticed the same day instead of days later.
//
// Trade-off: this can't distinguish "capture is down" from "genuinely no
// transactions" - a very quiet stretch will alert. The cron only fires at
// daytime-IST times (09:30 / 15:30 / 21:30 IST) so it never wakes you at night,
// and 8h is long enough that a normal active day always has activity.
const GAP_HOURS = 8;
// Don't re-push more than once per this window during a sustained outage, so
// frequent heartbeat checks (GitHub Actions every ~30m) don't spam.
const ALERT_THROTTLE_HOURS = 6;

// Second, independent signal: the iPhone Shortcuts automations POST
// /api/heartbeat every ~30 minutes. Silence here means the automations
// stopped firing, which is strictly worse than transaction silence - the Mac
// reconcile can only re-send messages that reached chat.db, so anything the
// phone never forwarded is lost rather than merely late.
//
// It lives in this route rather than a route of its own so there is one
// scheduled trigger and one alerting path to reason about, not two that can
// independently rot.
const PHONE_HEARTBEAT_GAP_MINUTES = 90;
const PHONE_ALERT_THROTTLE_HOURS = 6;

export async function GET() {
  // Both checks read settings; fetch once. select("*") so a missing column
  // (pre-migration) degrades to "no heartbeat recorded" instead of erroring
  // and taking the transaction-silence check down with it.
  const { data: settingsRow } = await supabase.from("settings").select("*").eq("id", 1).maybeSingle();
  const phone = await checkPhoneHeartbeat(settingsRow);

  const { data, error } = await supabase
    .from("transactions")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("capture-check query failed:", error);
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  const last = (data as { created_at?: string } | null)?.created_at ?? null;
  if (!last) {
    return NextResponse.json({ status: "OK", alerted: false, note: "no transactions yet", phone });
  }

  const gapHours = (Date.now() - Date.parse(last)) / (60 * 60 * 1000);
  const roundedGap = Math.round(gapHours * 10) / 10;
  if (gapHours <= GAP_HOURS) {
    return NextResponse.json({ status: "OK", alerted: false, gapHours: roundedGap, phone });
  }

  // Throttle: skip if we already alerted within ALERT_THROTTLE_HOURS.
  const lastAlert = (settingsRow as { last_capture_alert_at?: string | null } | null)?.last_capture_alert_at ?? null;
  if (lastAlert && Date.now() - Date.parse(lastAlert) < ALERT_THROTTLE_HOURS * 60 * 60 * 1000) {
    return NextResponse.json({ status: "OK", alerted: false, throttled: true, gapHours: roundedGap, phone });
  }

  const hrs = Math.floor(gapHours);
  const result = await sendPushToAll({
    title: "⚠️ Transaction capture may be down",
    body: `No transaction captured in ${hrs}h. The SMS pipeline (Shortcut + Mac reconcile) may have stopped — check it.`,
    tag: "sikka-capture",
    url: "/transactions",
  });
  await supabase.from("settings").upsert({ id: 1, last_capture_alert_at: new Date().toISOString() }, { onConflict: "id" });
  console.warn(`Capture heartbeat: ${hrs}h since last transaction; alert push sent to ${result.sent} device(s).`);
  return NextResponse.json({ status: "OK", alerted: true, gapHours: roundedGap, pushSent: result.sent, phone });
}

interface PhoneHeartbeatStatus {
  lastHeartbeat: string | null;
  ageMinutes: number | null;
  stale: boolean;
  alerted: boolean;
  throttled?: boolean;
  pushSent?: number;
}

// Independent of the transaction-silence check above: a quiet spending day is
// normal and says nothing about the phone, whereas the automations are
// supposed to fire on a timer regardless of activity. That makes this the
// sharper signal - it has no "genuinely nothing happened" false positive.
async function checkPhoneHeartbeat(settingsRow: unknown): Promise<PhoneHeartbeatStatus> {
  const row = settingsRow as {
    last_phone_heartbeat?: string | null;
    last_phone_heartbeat_alert_at?: string | null;
  } | null;
  const last = row?.last_phone_heartbeat ?? null;

  // Never pinged: the automations aren't set up yet (or the migration hasn't
  // run). Staying silent here is deliberate - arming an alert before the first
  // ping would fire continuously during setup and train the alert to be
  // ignored, which is the one thing a monitor must not do. It arms itself the
  // moment the first heartbeat lands.
  if (!last) {
    return { lastHeartbeat: null, ageMinutes: null, stale: false, alerted: false };
  }

  const ageMinutes = (Date.now() - Date.parse(last)) / 60000;
  const rounded = Math.round(ageMinutes);
  if (ageMinutes <= PHONE_HEARTBEAT_GAP_MINUTES) {
    return { lastHeartbeat: last, ageMinutes: rounded, stale: false, alerted: false };
  }

  const lastAlert = row?.last_phone_heartbeat_alert_at ?? null;
  if (lastAlert && Date.now() - Date.parse(lastAlert) < PHONE_ALERT_THROTTLE_HOURS * 60 * 60 * 1000) {
    return { lastHeartbeat: last, ageMinutes: rounded, stale: true, alerted: false, throttled: true };
  }

  try {
    // Same push fan-out the transaction-silence alert uses - one alerting
    // mechanism, one set of subscriptions, one service worker path. A distinct
    // tag so this doesn't collapse into that notification.
    const result = await sendPushToAll({
      title: "⚠️ Phone automations may be down",
      body: `No check-in from your iPhone Shortcuts in ${rounded}m. The SMS-capture Shortcut has likely stopped — check it.`,
      tag: "sikka-phone-heartbeat",
      url: "/capture-check",
    });
    await supabase
      .from("settings")
      .upsert({ id: 1, last_phone_heartbeat_alert_at: new Date().toISOString() }, { onConflict: "id" });
    console.warn(`Phone heartbeat: ${rounded}m since last check-in; alert push sent to ${result.sent} device(s).`);
    return { lastHeartbeat: last, ageMinutes: rounded, stale: true, alerted: true, pushSent: result.sent };
  } catch (err) {
    // Never let the phone check take down the transaction-silence check.
    console.error("Phone heartbeat alert failed:", err);
    return { lastHeartbeat: last, ageMinutes: rounded, stale: true, alerted: false };
  }
}
