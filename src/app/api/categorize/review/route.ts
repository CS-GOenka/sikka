import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { payeeKey } from "@/lib/payeeKey";

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
  const categoryName = (body as { category?: unknown })?.category;

  if (typeof transactionId !== "number") {
    return NextResponse.json(
      { status: "ERROR", error: "Expected a numeric 'transactionId' field" },
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
    const { data: allCategories } = await supabase.from("categories").select("name");
    return NextResponse.json(
      {
        status: "ERROR",
        error: `Unknown category "${categoryName}". Valid categories: ${(allCategories ?? [])
          .map((c) => c.name)
          .join(", ")}`,
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

  // Manual confirmation always wins: this correction applies to every future
  // transaction from this merchant, not just the one being reviewed here.
  // Keyed on the normalized payee so it covers every casing the bank sends -
  // correcting an "RAZ*SWIGGY" charge has to teach the next "RAZ*Swiggy" one
  // too, or the correction only ever sticks to the spelling it was made on.
  // Payee-less transactions (e.g. some IMPS credits) have no merchant name to
  // key a cache entry on, so just correct the transaction itself.
  if (transaction.payee) {
    const { error: upsertError } = await supabase.from("merchant_categories").upsert(
      {
        payee: payeeKey(transaction.payee),
        category_id: category.id,
        confidence_source: "manual",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "payee" }
    );

    if (upsertError) {
      console.error("Failed to upsert merchant_categories:", upsertError);
      return NextResponse.json({ status: "ERROR", error: upsertError.message }, { status: 500 });
    }
  }

  // Recategorizing fully resolves the row - clears both reasons it could
  // have been in the review queue (AI uncertainty and a manual star). Also
  // clears is_transfer: assigning a real spending category means the user is
  // saying this is spend, not a transfer (e.g. reclaiming an INFT that
  // defaulted to a transfer but was actually a person-to-person payment).
  const { error: updateError } = await supabase
    .from("transactions")
    .update({ category_id: category.id, needs_category_review: false, starred: false, is_transfer: false })
    .eq("id", transactionId);

  if (updateError) {
    console.error("Failed to update reviewed transaction:", updateError);
    return NextResponse.json({ status: "ERROR", error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({
    status: "OK",
    transactionId,
    payee: transaction.payee,
    category: category.name,
  });
}
