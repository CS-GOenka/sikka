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
  // How far this correction reaches. Defaults to this transaction alone,
  // because that is what a person is looking at when they change it - the
  // previous behaviour taught the cache on every correction with no way to
  // decline, so one dismissed Blinkit charge silently filed the next six as
  // non-spend.
  const applyToPayee = (body as { applyToPayee?: unknown })?.applyToPayee === true;

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
    .select("id, name, never_learn")
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

  // Three things have to be true before a correction teaches the cache.
  //
  // The caller has to ask for it. A correction is about the row in front of
  // the user unless they say otherwise; generalising by default hands them a
  // decision they never made and cannot see.
  //
  // The category has to be learnable. Ignore, House RFS and Gifts describe the
  // occasion, not the merchant - `amazon pay in e` is filed under six
  // categories at once because what was bought differs every time. Teaching
  // any of them pins a merchant to a one-off circumstance.
  //
  // And there has to be a payee to key on. Payee-less transactions (some IMPS
  // credits) have no merchant name, so only the transaction is corrected.
  //
  // The key itself is the normalized payee, so a correction covers every
  // casing the bank sends - correcting "RAZ*SWIGGY" has to teach the next
  // "RAZ*Swiggy" too, or it only ever sticks to the spelling it was made on.
  const learnable = applyToPayee && category.never_learn !== true && !!transaction.payee;
  if (learnable) {
    const { error: upsertError } = await supabase.from("merchant_categories").upsert(
      {
        payee: payeeKey(transaction.payee!),
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
    .update({
      category_id: category.id,
      needs_category_review: false,
      starred: false,
      is_transfer: false,
      // A person chose this one, whatever the scope. Scope decides what the
      // cache learns; it does not change who decided this row.
      category_source: "manual",
    })
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
    // Reported back so the UI can say what actually happened rather than what
    // it assumed would happen - a correction into a never_learn category is
    // silently narrower than "this payee from now on" would suggest.
    learned: learnable,
    ...(applyToPayee && !learnable
      ? {
          notLearnedReason: category.never_learn === true
            ? `${category.name} describes the occasion, not the merchant - not remembered for this payee`
            : "no payee to remember this against",
        }
      : {}),
  });
}
