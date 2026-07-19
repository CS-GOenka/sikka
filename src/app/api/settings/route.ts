import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  const { data, error } = await supabase
    .from("settings")
    .select("daily_budget")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    console.error("Failed to fetch settings:", error);
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  return NextResponse.json({ status: "OK", dailyBudget: data?.daily_budget ?? null });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse settings request body:", err);
    return NextResponse.json(
      { status: "ERROR", error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  const dailyBudget = (body as { dailyBudget?: unknown })?.dailyBudget;
  if (typeof dailyBudget !== "number" || !Number.isFinite(dailyBudget) || dailyBudget < 0) {
    return NextResponse.json(
      { status: "ERROR", error: "Expected a non-negative numeric 'dailyBudget' field" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("settings")
    .upsert({ id: 1, daily_budget: dailyBudget, updated_at: new Date().toISOString() }, { onConflict: "id" });

  if (error) {
    console.error("Failed to save settings:", error);
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  return NextResponse.json({ status: "OK", dailyBudget });
}
