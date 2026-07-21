import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse star request body:", err);
    return NextResponse.json(
      { status: "ERROR", error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  const transactionId = (body as { transactionId?: unknown })?.transactionId;
  const starred = (body as { starred?: unknown })?.starred;

  if (typeof transactionId !== "number") {
    return NextResponse.json(
      { status: "ERROR", error: "Expected a numeric 'transactionId' field" },
      { status: 400 }
    );
  }
  if (typeof starred !== "boolean") {
    return NextResponse.json(
      { status: "ERROR", error: "Expected a boolean 'starred' field" },
      { status: 400 }
    );
  }

  const { error } = await supabase.from("transactions").update({ starred }).eq("id", transactionId);

  if (error) {
    console.error(`Failed to update starred for transaction ${transactionId}:`, error);
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  return NextResponse.json({ status: "OK", transactionId, starred });
}
