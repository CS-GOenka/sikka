import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
// Imported, never re-declared: the alert logic and this display must agree on
// what "stale" means, or the banner will say healthy while the alert fires
// (or worse, the reverse).
import {
  PHONE_HEARTBEAT_GAP_MINUTES,
  CAPTURE_CHECK_STALE_MINUTES,
} from "@/lib/captureHealth";

// The reconcile cron is considered healthy if it has pinged within this window
// (it pings after every ~15-minute run; 45 min = 3 missed runs).
const STALE_MINUTES = 45;

// POST: heartbeat from the reconcile cron after a successful run.
export async function POST() {
  const { error } = await supabase
    .from("settings")
    .upsert({ id: 1, last_reconcile_ping: new Date().toISOString() }, { onConflict: "id" });
  if (error) {
    console.error("Failed to record reconcile heartbeat:", error);
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }
  return NextResponse.json({ status: "OK" });
}

const CAPTURE_STALE_HOURS = 8;

// GET: health status for the in-app banner. Reports both the reconcile
// heartbeat (is the Mac cron alive?) and capture freshness (has anything been
// ingested recently?), so an outage surfaces the moment you open the app -
// complementing the once-a-day Vercel cron. Uses select("*") so a missing
// column (pre-migration) doesn't error.
export async function GET() {
  const { data } = await supabase.from("settings").select("*").eq("id", 1).maybeSingle();
  const last = (data as { last_reconcile_ping?: string | null } | null)?.last_reconcile_ping ?? null;
  const ageMinutes = last ? Math.floor((Date.now() - Date.parse(last)) / 60000) : null;
  const stale = last !== null && ageMinutes !== null && ageMinutes > STALE_MINUTES;

  const { data: tx } = await supabase
    .from("transactions")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastCapture = (tx as { created_at?: string } | null)?.created_at ?? null;
  const captureAgeHours = lastCapture ? (Date.now() - Date.parse(lastCapture)) / (60 * 60 * 1000) : null;
  const captureStale = captureAgeHours !== null && captureAgeHours > CAPTURE_STALE_HOURS;

  const row = data as {
    last_phone_heartbeat?: string | null;
    last_capture_check_at?: string | null;
  } | null;

  // Phone heartbeat. "Armed" is reported separately from "stale" on purpose:
  // the alert deliberately stays silent until the first ping ever arrives, so
  // an unarmed monitor and a healthy one used to look identical from outside.
  // A cancelled-automations test against an unarmed monitor produces no alert
  // and no explanation, which is exactly how a real test went unanswered.
  const lastPhone = row?.last_phone_heartbeat ?? null;
  const phoneAgeMinutes = lastPhone ? Math.floor((Date.now() - Date.parse(lastPhone)) / 60000) : null;
  const phoneArmed = lastPhone !== null;
  const phoneStale = phoneAgeMinutes !== null && phoneAgeMinutes > PHONE_HEARTBEAT_GAP_MINUTES;

  // Meta-monitor: the scheduled check is what raises every other alert, so if
  // it stops, no alert can be trusted to arrive - including the ones that
  // would report these very outages. Null means the column exists but nothing
  // has run since it was added, which is not yet evidence of a problem.
  const lastCheck = row?.last_capture_check_at ?? null;
  const checkAgeMinutes = lastCheck ? Math.floor((Date.now() - Date.parse(lastCheck)) / 60000) : null;
  const monitorStale = checkAgeMinutes !== null && checkAgeMinutes > CAPTURE_CHECK_STALE_MINUTES;

  return NextResponse.json({
    status: "OK",
    lastPing: last,
    ageMinutes,
    stale,
    lastCapture,
    captureAgeHours: captureAgeHours === null ? null : Math.round(captureAgeHours * 10) / 10,
    captureStale,
    phoneHeartbeat: {
      last: lastPhone,
      ageMinutes: phoneAgeMinutes,
      armed: phoneArmed,
      stale: phoneStale,
      thresholdMinutes: PHONE_HEARTBEAT_GAP_MINUTES,
    },
    monitor: {
      lastCheck,
      ageMinutes: checkAgeMinutes,
      stale: monitorStale,
      thresholdMinutes: CAPTURE_CHECK_STALE_MINUTES,
    },
  });
}
