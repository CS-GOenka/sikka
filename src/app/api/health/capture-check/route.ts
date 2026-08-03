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
// frequent heartbeat checks (GitHub Actions ~every 2h) don't spam.
const ALERT_THROTTLE_HOURS = 6;

export async function GET() {
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
    return NextResponse.json({ status: "OK", alerted: false, note: "no transactions yet" });
  }

  const gapHours = (Date.now() - Date.parse(last)) / (60 * 60 * 1000);
  const roundedGap = Math.round(gapHours * 10) / 10;
  if (gapHours <= GAP_HOURS) {
    return NextResponse.json({ status: "OK", alerted: false, gapHours: roundedGap });
  }

  // Throttle: skip if we already alerted within ALERT_THROTTLE_HOURS.
  const { data: settings } = await supabase.from("settings").select("*").eq("id", 1).maybeSingle();
  const lastAlert = (settings as { last_capture_alert_at?: string | null } | null)?.last_capture_alert_at ?? null;
  if (lastAlert && Date.now() - Date.parse(lastAlert) < ALERT_THROTTLE_HOURS * 60 * 60 * 1000) {
    return NextResponse.json({ status: "OK", alerted: false, throttled: true, gapHours: roundedGap });
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
  return NextResponse.json({ status: "OK", alerted: true, gapHours: roundedGap, pushSent: result.sent });
}
