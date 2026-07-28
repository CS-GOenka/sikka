import { NextResponse } from "next/server";
import { sendPushToAll } from "@/lib/push";

// Fires a dummy notification to every stored subscription. Used to verify
// Web Push delivery end-to-end, in isolation from any budget logic.
export async function POST() {
  try {
    const result = await sendPushToAll({
      title: "Sikka test notification",
      body: "If you can see this, Web Push is working 🎉",
      tag: "sikka-test",
      url: "/settings",
    });
    return NextResponse.json({ status: "OK", ...result });
  } catch (err) {
    console.error("Test push failed:", err);
    return NextResponse.json(
      { status: "ERROR", error: err instanceof Error ? err.message : "Failed to send test push" },
      { status: 500 }
    );
  }
}
