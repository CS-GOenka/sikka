import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse ingest request body:", err);
    return NextResponse.json(
      { status: "ERROR", error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  const message = (body as { message?: unknown })?.message;
  if (typeof message !== "string" || message.trim().length === 0) {
    return NextResponse.json({ status: "OK" });
  }

  const sensitivePatterns = [/otp/i, /one-time password/i, /do not disclose/i];
  if (sensitivePatterns.some((pattern) => pattern.test(message))) {
    return NextResponse.json({ status: "OK" });
  }

  try {
    const { error } = await supabase.from("raw_messages").insert({ message });

    if (error) {
      console.error("Supabase insert into raw_messages failed:", {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      });
      return NextResponse.json(
        { status: "ERROR", error: error.message },
        { status: 500 }
      );
    }
  } catch (err) {
    console.error("Unexpected error inserting into raw_messages:", err);
    return NextResponse.json(
      { status: "ERROR", error: "Unexpected error while inserting message" },
      { status: 500 }
    );
  }

  console.log("Inserted raw message:", message);
  return NextResponse.json({ status: "OK" });
}
