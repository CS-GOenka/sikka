import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { payeeKey } from "@/lib/payeeKey";

type Change = { payee: string; category: string };

// Payee-level bulk recategorization for /cleanup. Unlike /api/categorize/review
// (one transaction at a time), each change updates merchant_categories AND
// every existing transaction from that payee in one action - the point of
// /cleanup is working through a payee once, not transaction-by-transaction.
//
// Accepts a batch: { changes: [{ payee, category }, ...] } so the whole
// cleanup screen can be edited freely and submitted in a single click. A
// legacy single-change body { payee, category } is still accepted.

// Every raw spelling in `transactions` that shares a payee key, grouped by
// that key. The update below has to reach all of them: the bank sends the same
// merchant as both "RAZ*Swiggy" and "RAZ*SWIGGY", and matching the one string
// the user happened to click would silently leave the other spelling's
// transactions on their old category while reporting success.
async function payeeVariantsByKey(): Promise<Map<string, string[]>> {
  const byKey = new Map<string, string[]>();
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("transactions")
      .select("payee")
      .not("payee", "is", null)
      .range(offset, offset + 999);
    if (error) throw new Error(`Failed to list payees: ${error.message}`);
    for (const { payee } of data ?? []) {
      if (!payee) continue;
      const key = payeeKey(payee);
      const seen = byKey.get(key);
      if (!seen) byKey.set(key, [payee]);
      else if (!seen.includes(payee)) seen.push(payee);
    }
    if (!data || data.length < 1000) return byKey;
    offset += 1000;
  }
}

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

  let variantsByKey: Map<string, string[]>;
  try {
    variantsByKey = await payeeVariantsByKey();
  } catch (err) {
    console.error("Failed to build the payee variant index:", err);
    return NextResponse.json(
      { status: "ERROR", error: err instanceof Error ? err.message : "Failed to list payees" },
      { status: 500 }
    );
  }

  const results: { payee: string; category: string; updatedCount: number }[] = [];
  for (const { payee, category } of changes) {
    const categoryId = nameToId.get(category)!;
    const key = payeeKey(payee);

    const { error: upsertError } = await supabase.from("merchant_categories").upsert(
      {
        payee: key,
        category_id: categoryId,
        confidence_source: "manual",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "payee" }
    );
    if (upsertError) {
      console.error(`Failed to upsert merchant_categories for payee "${key}":`, upsertError);
      return NextResponse.json({ status: "ERROR", error: upsertError.message }, { status: 500 });
    }

    // `payee` itself may not be in the index (a payee with a cache row but no
    // surviving transaction), so fall back to it rather than matching nothing.
    const variants = variantsByKey.get(key) ?? [payee];
    const { data: updated, error: updateError } = await supabase
      .from("transactions")
      .update({ category_id: categoryId, needs_category_review: false })
      .in("payee", variants)
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
