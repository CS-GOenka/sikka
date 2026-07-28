import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  // select * so a missing day_reset_hour column (pre-migration) doesn't error.
  const { data, error } = await supabase.from("settings").select("*").eq("id", 1).maybeSingle();

  if (error) {
    console.error("Failed to fetch settings:", error);
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  const row = data as { daily_budget?: number | null; day_reset_hour?: number | null } | null;
  return NextResponse.json({
    status: "OK",
    dailyBudget: row?.daily_budget ?? null,
    dayResetHour: row?.day_reset_hour ?? 3,
  });
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

  const { dailyBudget, dayResetHour } = body as { dailyBudget?: unknown; dayResetHour?: unknown };

  const update: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() };

  if (dailyBudget !== undefined) {
    if (typeof dailyBudget !== "number" || !Number.isFinite(dailyBudget) || dailyBudget < 0) {
      return NextResponse.json(
        { status: "ERROR", error: "Expected a non-negative numeric 'dailyBudget' field" },
        { status: 400 }
      );
    }
    update.daily_budget = dailyBudget;
  }

  if (dayResetHour !== undefined) {
    if (typeof dayResetHour !== "number" || !Number.isInteger(dayResetHour) || dayResetHour < 0 || dayResetHour > 23) {
      return NextResponse.json(
        { status: "ERROR", error: "Expected an integer 'dayResetHour' between 0 and 23" },
        { status: 400 }
      );
    }
    update.day_reset_hour = dayResetHour;
  }

  const { error } = await supabase.from("settings").upsert(update, { onConflict: "id" });

  if (error) {
    console.error("Failed to save settings:", error);
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  return NextResponse.json({ status: "OK" });
}
