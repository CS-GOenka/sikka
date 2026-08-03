import { NextRequest, NextResponse } from "next/server";
import { sendPushToAll } from "@/lib/push";

// Called by the reconcile cron when it fails (e.g. it can't read chat.db -
// "authorization denied" when Full Disk Access is revoked). Fires a push so an
// ingestion failure is visible immediately instead of silently for days.
export async function POST(request: NextRequest) {
  let message = "Ingestion error";
  try {
    const body = await request.json();
    if (typeof body?.message === "string" && body.message.trim()) message = body.message.trim();
  } catch {
    // keep default
  }
  try {
    await sendPushToAll({
      title: "⚠️ Sikka ingestion problem",
      body: message.slice(0, 180),
      tag: "sikka-health",
      url: "/transactions",
    });
  } catch (err) {
    console.error("Health alert push failed:", err);
  }
  return NextResponse.json({ status: "OK" });
}
