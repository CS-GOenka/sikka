import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Payee-level bulk recategorization for /cleanup: unlike /api/categorize/review
// (one transaction at a time), this updates merchant_categories AND every
// existing transaction from that payee in one action - the point of
// /cleanup is working through a payee once, not transaction-by-transaction.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse cleanup recategorize body:", err);
    return NextResponse.json(
      { status: "ERROR", error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  const payee = (body as { payee?: unknown })?.payee;
  const categoryName = (body as { category?: unknown })?.category;

  if (typeof payee !== "string" || payee.trim().length === 0) {
    return NextResponse.json(
      { status: "ERROR", error: "Expected a non-empty string 'payee' field" },
      { status: 400 }
    );
  }
  if (typeof categoryName !== "string") {
    return NextResponse.json(
      { status: "ERROR", error: "Expected a string 'category' field naming a category" },
      { status: 400 }
    );
  }

  const { data: category, error: categoryError } = await supabase
    .from("categories")
    .select("id, name")
    .eq("name", categoryName)
    .single();

  if (categoryError || !category) {
    return NextResponse.json(
      { status: "ERROR", error: `Unknown category "${categoryName}"` },
      { status: 400 }
    );
  }

  const { error: upsertError } = await supabase.from("merchant_categories").upsert(
    {
      payee,
      category_id: category.id,
      confidence_source: "manual",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "payee" }
  );

  if (upsertError) {
    console.error(`Failed to upsert merchant_categories for payee "${payee}":`, upsertError);
    return NextResponse.json({ status: "ERROR", error: upsertError.message }, { status: 500 });
  }

  const { data: updated, error: updateError } = await supabase
    .from("transactions")
    .update({ category_id: category.id, needs_category_review: false })
    .eq("payee", payee)
    .select("id");

  if (updateError) {
    console.error(`Failed to bulk-update transactions for payee "${payee}":`, updateError);
    return NextResponse.json({ status: "ERROR", error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({
    status: "OK",
    payee,
    category: category.name,
    updatedCount: updated?.length ?? 0,
  });
}
