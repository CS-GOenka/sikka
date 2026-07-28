import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

type Change = { payee: string; category: string };

// Payee-level bulk recategorization for /cleanup. Unlike /api/categorize/review
// (one transaction at a time), each change updates merchant_categories AND
// every existing transaction from that payee in one action - the point of
// /cleanup is working through a payee once, not transaction-by-transaction.
//
// Accepts a batch: { changes: [{ payee, category }, ...] } so the whole
// cleanup screen can be edited freely and submitted in a single click. A
// legacy single-change body { payee, category } is still accepted.
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

  const raw = body as { changes?: unknown; payee?: unknown; category?: unknown };
  const rawChanges: unknown[] = Array.isArray(raw.changes)
    ? raw.changes
    : [{ payee: raw.payee, category: raw.category }];

  const changes: Change[] = [];
  for (const c of rawChanges) {
    const payee = (c as { payee?: unknown })?.payee;
    const category = (c as { category?: unknown })?.category;
    if (typeof payee !== "string" || payee.trim().length === 0) {
      return NextResponse.json(
        { status: "ERROR", error: "Each change needs a non-empty string 'payee'" },
        { status: 400 }
      );
    }
    if (typeof category !== "string" || category.trim().length === 0) {
      return NextResponse.json(
        { status: "ERROR", error: "Each change needs a string 'category' naming a category" },
        { status: 400 }
      );
    }
    changes.push({ payee, category });
  }

  if (changes.length === 0) {
    return NextResponse.json({ status: "ERROR", error: "No changes provided" }, { status: 400 });
  }

  // Resolve every distinct category name up front so an unknown name fails the
  // whole batch before any writes happen.
  const nameToId = new Map<string, number>();
  for (const name of new Set(changes.map((c) => c.category))) {
    const { data: category, error } = await supabase
      .from("categories")
      .select("id, name")
      .eq("name", name)
      .single();
    if (error || !category) {
      return NextResponse.json({ status: "ERROR", error: `Unknown category "${name}"` }, { status: 400 });
    }
    nameToId.set(name, category.id);
  }

  const results: { payee: string; category: string; updatedCount: number }[] = [];
  for (const { payee, category } of changes) {
    const categoryId = nameToId.get(category)!;

    const { error: upsertError } = await supabase.from("merchant_categories").upsert(
      {
        payee,
        category_id: categoryId,
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
      .update({ category_id: categoryId, needs_category_review: false })
      .eq("payee", payee)
      .select("id");
    if (updateError) {
      console.error(`Failed to bulk-update transactions for payee "${payee}":`, updateError);
      return NextResponse.json({ status: "ERROR", error: updateError.message }, { status: 500 });
    }

    results.push({ payee, category, updatedCount: updated?.length ?? 0 });
  }

  return NextResponse.json({
    status: "OK",
    changedPayees: results.length,
    updatedTransactions: results.reduce((sum, r) => sum + r.updatedCount, 0),
    results,
  });
}
