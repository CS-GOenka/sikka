import { supabase } from "@/lib/supabase";
import { CleanupTable, type CleanupRow } from "@/components/CleanupTable";

export const dynamic = "force-dynamic";

export default async function CleanupPage() {
  const { data: parent } = await supabase.from("categories").select("id").eq("name", "Person-to-Person").single();

  if (!parent) {
    return (
      <main className="p-6">
        <p className="text-red-600">Person-to-Person category not found.</p>
      </main>
    );
  }

  // The two buckets a Person-to-Person payee can be split into. Read live from
  // the category tree (children of Person-to-Person) so adding/renaming one
  // needs no code change here.
  const { data: children } = await supabase
    .from("categories")
    .select("id, name")
    .eq("parent_id", parent.id)
    .order("name");
  const options = (children ?? []).map((c) => c.name);

  // Only payees still sitting on the Person-to-Person *parent* itself are
  // unresolved - once split into Friends/Family (real leaf categories) they
  // drop off this queue.
  let allTx: { payee: string | null; amount: number | null; currency: string; transaction_date: string | null }[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("transactions")
      .select("payee, amount, currency, transaction_date")
      .eq("category_id", parent.id)
      .not("payee", "is", null)
      .range(offset, offset + 999);
    if (error) {
      return (
        <main className="p-6">
          <p className="text-red-600">Failed to load cleanup queue: {error.message}</p>
        </main>
      );
    }
    allTx = allTx.concat(data ?? []);
    if (!data || data.length < 1000) break;
    offset += 1000;
  }

  const byPayee = new Map<string, CleanupRow>();
  for (const tx of allTx) {
    if (!tx.payee) continue;
    let row = byPayee.get(tx.payee);
    if (!row) {
      row = { payee: tx.payee, txCount: 0, totalInr: 0, firstDate: null, lastDate: null };
      byPayee.set(tx.payee, row);
    }
    row.txCount += 1;
    if (tx.currency === "INR") row.totalInr += tx.amount ?? 0;
    if (tx.transaction_date) {
      if (!row.firstDate || tx.transaction_date < row.firstDate) row.firstDate = tx.transaction_date;
      if (!row.lastDate || tx.transaction_date > row.lastDate) row.lastDate = tx.transaction_date;
    }
  }

  const rows = [...byPayee.values()].sort((a, b) => b.totalInr - a.totalInr);

  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Person-to-Person cleanup</h1>
      <p className="text-sm text-zinc-500">
        {rows.length} unique payee{rows.length === 1 ? "" : "s"} still to split into Friends or Family. Set each
        one, then click Save — every transaction from that payee is updated at once and drops off this list.
      </p>

      <CleanupTable rows={rows} options={options} />
    </main>
  );
}
