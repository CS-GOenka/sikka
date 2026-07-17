import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { MERCHANT_CATEGORIES } from "@/lib/gemini";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse categorize review request body:", err);
    return NextResponse.json(
      { status: "ERROR", error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  const transactionId = (body as { transactionId?: unknown })?.transactionId;
  const category = (body as { category?: unknown })?.category;

  if (typeof transactionId !== "number") {
    return NextResponse.json(
      { status: "ERROR", error: "Expected a numeric 'transactionId' field" },
      { status: 400 }
    );
  }
  if (typeof category !== "string" || !(MERCHANT_CATEGORIES as readonly string[]).includes(category)) {
    return NextResponse.json(
      {
        status: "ERROR",
        error: `Expected 'category' to be one of: ${MERCHANT_CATEGORIES.join(", ")}`,
      },
      { status: 400 }
    );
  }

  const { data: transaction, error: fetchError } = await supabase
    .from("transactions")
    .select("id, payee")
    .eq("id", transactionId)
    .single();

  if (fetchError || !transaction) {
    console.error("Failed to fetch transaction for review:", fetchError);
    return NextResponse.json(
      { status: "ERROR", error: `Transaction ${transactionId} not found` },
      { status: 404 }
    );
  }
  if (!transaction.payee) {
    return NextResponse.json(
      { status: "ERROR", error: `Transaction ${transactionId} has no payee to categorize` },
      { status: 400 }
    );
  }

  // Manual confirmation always wins: this correction applies to every future
  // transaction from this merchant, not just the one being reviewed here.
  const { error: upsertError } = await supabase.from("merchant_categories").upsert(
    {
      payee: transaction.payee,
      category,
      confidence_source: "manual",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "payee" }
  );

  if (upsertError) {
    console.error("Failed to upsert merchant_categories:", upsertError);
    return NextResponse.json({ status: "ERROR", error: upsertError.message }, { status: 500 });
  }

  const { error: updateError } = await supabase
    .from("transactions")
    .update({ category, needs_category_review: false })
    .eq("id", transactionId);

  if (updateError) {
    console.error("Failed to update reviewed transaction:", updateError);
    return NextResponse.json({ status: "ERROR", error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({
    status: "OK",
    transactionId,
    payee: transaction.payee,
    category,
  });
}
