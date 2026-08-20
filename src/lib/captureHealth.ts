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
//
// 60m against a ~30m ping interval means two consecutive missed pings trip the
// alert (age passes 60 just after the second miss); one late or dropped ping
// stays quiet. The single source of truth for this threshold - nothing else,
// display or check, carries its own copy.
export const PHONE_HEARTBEAT_GAP_MINUTES = 60;
const PHONE_ALERT_THROTTLE_HOURS = 6;

// The scheduler (cron-job.org) calls this every 30 minutes, so three missed
// runs is a real outage rather than one late invocation. Exported for the
// in-app banner, which must not carry its own copy of this number.
export const CAPTURE_CHECK_STALE_MINUTES = 95;

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

  // Record the invocation before doing any work, so this says "the scheduler
  // reached us" rather than "the checks succeeded". Those are different
  // failures and conflating them is what made a missed alert hard to diagnose:
  // previously the only evidence a run had happened at all was the side effect
  // of an alert that fired, so a quiet period was indistinguishable from a
  // dead cron. Best-effort - a failure here must never block the checks.
  const { error: markError } = await supabase
    .from("settings")
    .upsert({ id: 1, last_capture_check_at: new Date().toISOString() }, { onConflict: "id" });
  if (markError) {
    console.error("Failed to record capture-check invocation:", markError);
  }

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
  // false only before the very first ping ever recorded.
  everArmed: boolean;
  // The heartbeat record vanished after the monitor had been armed - a
  // different failure from the phone going quiet, and a different fix.
  anomaly?: boolean;
}

// Shared send + throttle for both phone alerts, so the anomaly path cannot
// drift from the staleness path (or forget to throttle and spam every 30
// minutes during an outage).
async function firePhoneAlert(
  lastAlert: string | null,
  payload: { title: string; body: string }
): Promise<{ alerted: boolean; throttled?: boolean; pushSent?: number }> {
  if (lastAlert && Date.now() - Date.parse(lastAlert) < PHONE_ALERT_THROTTLE_HOURS * 60 * 60 * 1000) {
    return { alerted: false, throttled: true };
  }
  try {
    // Same push fan-out the transaction-silence alert uses - one alerting
    // mechanism, one set of subscriptions, one service worker path.
    const result = await sendPushToAll({
      ...payload,
      tag: "sikka-phone-heartbeat",
      url: "/capture-check",
    });
    await supabase
      .from("settings")
      .upsert({ id: 1, last_phone_heartbeat_alert_at: new Date().toISOString() }, { onConflict: "id" });
    return { alerted: true, pushSent: result.sent };
  } catch (err) {
    // Never let a push failure take down the transaction-silence check.
    console.error("Phone heartbeat alert failed:", err);
    return { alerted: false };
  }
}

// Independent of the transaction-silence check: a quiet spending day is
// normal and says nothing about the phone, whereas the automations are
// supposed to fire on a timer regardless of activity. That makes this the
// sharper signal - it has no "genuinely nothing happened" false positive.
async function checkPhoneHeartbeat(settingsRow: unknown): Promise<PhoneHeartbeatStatus> {
  const row = settingsRow as {
    last_phone_heartbeat?: string | null;
    last_phone_heartbeat_alert_at?: string | null;
    phone_heartbeat_ever_armed?: boolean | null;
  } | null;
  const last = row?.last_phone_heartbeat ?? null;
  const lastAlert = row?.last_phone_heartbeat_alert_at ?? null;
  const everArmed = row?.phone_heartbeat_ever_armed === true;

  if (!last) {
    // (a) Never armed: the automations aren't set up yet. Stay silent -
    // alerting before the first ping would fire continuously during setup and
    // train the alert to be ignored, which is the one thing a monitor must not
    // do. It arms itself the moment the first heartbeat lands.
    if (!everArmed) {
      return { lastHeartbeat: null, ageMinutes: null, stale: false, alerted: false, everArmed: false };
    }

    // (b) Armed before, record now gone. Previously indistinguishable from (a)
    // and therefore silently suppressed - which disarmed the entire alarm and
    // made a real cancelled-automations test produce nothing at all. The phone
    // may be fine here; what is broken is the monitoring state itself, so the
    // wording points at that rather than at the Shortcut.
    const fired = await firePhoneAlert(lastAlert, {
      title: "⚠️ Heartbeat monitoring state lost",
      body: "The phone check-in record was cleared after setup. Capture may be fine, but the missing-ping alarm is disarmed until a ping arrives — check Sikka.",
    });
    console.warn("Phone heartbeat: record is null despite having been armed - treating as an anomaly.");
    return { lastHeartbeat: null, ageMinutes: null, stale: true, anomaly: true, everArmed: true, ...fired };
  }

  const ageMinutes = (Date.now() - Date.parse(last)) / 60000;
  const rounded = Math.round(ageMinutes);
  if (ageMinutes <= PHONE_HEARTBEAT_GAP_MINUTES) {
    return { lastHeartbeat: last, ageMinutes: rounded, stale: false, alerted: false, everArmed };
  }

  const fired = await firePhoneAlert(lastAlert, {
    title: "⚠️ Phone automations may be down",
    body: `No check-in from your iPhone Shortcuts in ${rounded}m. The SMS-capture Shortcut has likely stopped — check it.`,
  });
  if (fired.alerted) {
    console.warn(`Phone heartbeat: ${rounded}m since last check-in; alert push sent to ${fired.pushSent} device(s).`);
  }
  return { lastHeartbeat: last, ageMinutes: rounded, stale: true, everArmed, ...fired };
}
