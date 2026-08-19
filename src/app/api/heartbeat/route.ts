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
  const { error } = await supabase
    .from("settings")
    .upsert({ id: 1, last_phone_heartbeat: new Date().toISOString() }, { onConflict: "id" });

  if (error) {
    console.error("Failed to record phone heartbeat:", error);
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  return NextResponse.json({ status: "OK" });
}
