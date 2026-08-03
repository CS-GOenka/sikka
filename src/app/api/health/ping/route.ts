import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

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

// GET: health status for the in-app banner. Uses select("*") so a missing
// column (pre-migration) doesn't error. Only reports stale once there has been
// at least one ping, to avoid a false alarm before the cron is wired up.
export async function GET() {
  const { data } = await supabase.from("settings").select("*").eq("id", 1).maybeSingle();
  const last = (data as { last_reconcile_ping?: string | null } | null)?.last_reconcile_ping ?? null;
  const ageMinutes = last ? Math.floor((Date.now() - Date.parse(last)) / 60000) : null;
  const stale = last !== null && ageMinutes !== null && ageMinutes > STALE_MINUTES;
  return NextResponse.json({ status: "OK", lastPing: last, ageMinutes, stale });
}
