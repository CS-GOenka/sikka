import { supabase } from "@/lib/supabase";
import { sendPushToAll } from "@/lib/push";

// Two independent "is capture still alive?" checks, run together by whatever
// scheduler is driving them. Deliberately independent of both the Mac and the
// phone, since those are exactly what's being watched.
//
// Extracted from the old /api/health/capture-check route so the scheduled
// entry point can be swapped (GitHub Actions -> cron-job.org) without the
// logic moving with it.

// Check 1: transaction silence.
// Trade-off: this can't distinguish "capture is down" from "genuinely no
// transactions" - a very quiet stretch will alert. 8h is long enough that a
// normal active day always has activity.
const GAP_HOURS = 8;
// Don't re-push more than once per this window during a sustained outage, so
// a ~30m check cadence doesn't spam.
const ALERT_THROTTLE_HOURS = 6;

// Check 2: the iPhone Shortcuts automations POST /api/heartbeat every ~30
// minutes. Silence here means the automations stopped firing, which is
// strictly worse than transaction silence - the Mac reconcile can only re-send
// messages that reached chat.db, so anything the phone never forwarded is lost
// rather than merely late.
const PHONE_HEARTBEAT_GAP_MINUTES = 90;
const PHONE_ALERT_THROTTLE_HOURS = 6;

export interface CaptureHealthResult {
  status: "OK" | "ERROR";
  error?: string;
  note?: string;
  alerted?: boolean;
  throttled?: boolean;
  gapHours?: number;
  pushSent?: number;
  phone?: PhoneHeartbeatStatus;
}

export async function runCaptureHealthChecks(): Promise<CaptureHealthResult> {
  // Both checks read settings; fetch once.
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
    return { status: "ERROR", error: error.message, phone };
  }

  const last = (data as { created_at?: string } | null)?.created_at ?? null;
  if (!last) {
    return { status: "OK", alerted: false, note: "no transactions yet", phone };
  }

  const gapHours = (Date.now() - Date.parse(last)) / (60 * 60 * 1000);
  const roundedGap = Math.round(gapHours * 10) / 10;
  if (gapHours <= GAP_HOURS) {
    return { status: "OK", alerted: false, gapHours: roundedGap, phone };
  }

  // Throttle: skip if we already alerted within ALERT_THROTTLE_HOURS.
  const lastAlert = (settingsRow as { last_capture_alert_at?: string | null } | null)?.last_capture_alert_at ?? null;
  if (lastAlert && Date.now() - Date.parse(lastAlert) < ALERT_THROTTLE_HOURS * 60 * 60 * 1000) {
    return { status: "OK", alerted: false, throttled: true, gapHours: roundedGap, phone };
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
  return { status: "OK", alerted: true, gapHours: roundedGap, pushSent: result.sent, phone };
}

interface PhoneHeartbeatStatus {
  lastHeartbeat: string | null;
  ageMinutes: number | null;
  stale: boolean;
  alerted: boolean;
  throttled?: boolean;
  pushSent?: number;
}

// Independent of the transaction-silence check: a quiet spending day is
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
