import { supabase } from "@/lib/supabase";
import { getAssignableCategories } from "@/lib/gemini";
import { PayeeCategoryPicker } from "@/components/PayeeCategoryPicker";

export const dynamic = "force-dynamic";

type CleanupRow = {
  payee: string;
  txCount: number;
  totalInr: number;
  firstDate: string | null;
  lastDate: string | null;
};

export default async function CleanupPage() {
  const { data: parent } = await supabase.from("categories").select("id").eq("name", "Person-to-Person").single();

  if (!parent) {
    return (
      <main className="p-6">
        <p className="text-red-600">Person-to-Person category not found.</p>
      </main>
    );
  }

  const { data: children } = await supabase.from("categories").select("id").eq("parent_id", parent.id);
  const categoryIds = [parent.id, ...(children ?? []).map((c) => c.id)];

  let allTx: { payee: string | null; amount: number | null; currency: string; transaction_date: string | null }[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("transactions")
      .select("payee, amount, currency, transaction_date")
      .in("category_id", categoryIds)
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
  const categories = await getAssignableCategories();

  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Person-to-Person cleanup</h1>
      <p className="text-sm text-zinc-500">
        {rows.length} unique payee{rows.length === 1 ? "" : "s"} currently under Person-to-Person or a child category.
        Recategorizing a payee here updates every transaction from that payee at once, and it drops off this list.
      </p>

      <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
        <table className="min-w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 font-medium">Payee</th>
              <th className="px-3 py-2 font-medium">Tx count</th>
              <th className="px-3 py-2 font-medium">Total ₹</th>
              <th className="px-3 py-2 font-medium">First</th>
              <th className="px-3 py-2 font-medium">Last</th>
              <th className="px-3 py-2 font-medium">Recategorize</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.payee} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className="px-3 py-2">{row.payee}</td>
                <td className="px-3 py-2 text-zinc-500">{row.txCount}</td>
                <td className="whitespace-nowrap px-3 py-2 font-medium">
                  {row.totalInr.toLocaleString("en-IN")}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-zinc-500">{row.firstDate ?? "—"}</td>
                <td className="whitespace-nowrap px-3 py-2 text-zinc-500">{row.lastDate ?? "—"}</td>
                <td className="px-3 py-2">
                  <PayeeCategoryPicker payee={row.payee} categories={categories} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                  Nothing left to clean up.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
