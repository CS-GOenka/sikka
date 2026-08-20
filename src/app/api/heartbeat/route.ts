import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Check-in from the iPhone Shortcuts automations (~every 30 minutes).
//
// Deliberately the simplest possible contract: no body, no auth, no
// parameters - a Shortcuts "Get Contents of URL" action set to POST and
// nothing else. Anything the phone would have to compute or format is
// another thing that can silently break on the device, and this endpoint
// exists precisely to detect the device going quiet.
//
// What it proves is narrow but exactly what's needed: the automations are
// still firing. The SMS-capture Shortcut dying is the failure mode that
// loses transactions for good - the Mac reconcile is only a safety net for
// messages that did reach chat.db, so it cannot backfill what the phone
// never forwarded.
export async function POST() {
  const now = new Date().toISOString();

  // phone_heartbeat_ever_armed latches true on the first ping and never goes
  // back. It is what lets the check tell "never set up" (stay quiet) apart
  // from "was set up, record now missing" (an anomaly worth alerting on).
  const { error } = await supabase
    .from("settings")
    .upsert(
      { id: 1, last_phone_heartbeat: now, phone_heartbeat_ever_armed: true },
      { onConflict: "id" }
    );

  if (error) {
    // If the column isn't there yet (deploy landed before the migration), fall
    // back to writing the timestamp alone. Failing outright would stop
    // recording heartbeats altogether, and a monitor that stops seeing pings
    // raises a false outage alert - the opposite of what this change is for.
    console.error("Failed to record phone heartbeat with armed flag:", error);
    const { error: fallbackError } = await supabase
      .from("settings")
      .upsert({ id: 1, last_phone_heartbeat: now }, { onConflict: "id" });
    if (fallbackError) {
      console.error("Failed to record phone heartbeat:", fallbackError);
      return NextResponse.json({ status: "ERROR", error: fallbackError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ status: "OK" });
}
