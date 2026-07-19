import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { getAssignableCategories } from "@/lib/gemini";
import { CategoryPicker } from "@/components/CategoryPicker";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type TransactionRow = {
  id: number;
  payee: string | null;
  amount: number | null;
  currency: string;
  transaction_date: string | null;
  type: string;
  categories: { name: string } | null;
};

function formatAmount(amount: number | null, currency: string, type: string) {
  if (amount === null) return "—";
  const sign = type === "debit" ? "-" : type === "credit" ? "+" : "";
  return `${sign}${currency} ${amount.toLocaleString("en-IN")}`;
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, parseInt(Array.isArray(pageParam) ? pageParam[0] : pageParam ?? "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const [{ data, count, error }, categories] = await Promise.all([
    supabase
      .from("transactions")
      .select("id, payee, amount, currency, transaction_date, type, categories(name)", {
        count: "exact",
      })
      .neq("type", "ignored")
      .order("transaction_date", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false })
      .range(from, to)
      .returns<TransactionRow[]>(),
    getAssignableCategories(),
  ]);

  if (error) {
    return (
      <main className="p-6">
        <p className="text-red-600">Failed to load transactions: {error.message}</p>
      </main>
    );
  }

  const rows = data ?? [];
  const total = count ?? 0;
  const hasNext = to < total - 1;
  const hasPrev = page > 1;

  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Transactions</h1>
      <p className="text-sm text-zinc-500">{total} total</p>

      <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
        <table className="min-w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Payee</th>
              <th className="px-3 py-2 font-medium">Amount</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Category</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className="whitespace-nowrap px-3 py-2 text-zinc-500">
                  {row.transaction_date ?? "—"}
                </td>
                <td className="px-3 py-2">{row.payee ?? "—"}</td>
                <td
                  className={`whitespace-nowrap px-3 py-2 font-medium ${
                    row.type === "credit"
                      ? "text-emerald-600"
                      : row.type === "debit"
                        ? "text-zinc-900 dark:text-zinc-100"
                        : "text-zinc-500"
                  }`}
                >
                  {formatAmount(row.amount, row.currency, row.type)}
                </td>
                <td className="px-3 py-2 text-zinc-500">{row.type}</td>
                <td className="px-3 py-2">
                  <CategoryPicker
                    transactionId={row.id}
                    currentCategoryName={row.categories?.name ?? null}
                    categories={categories}
                  />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">
                  No transactions found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <Link
          href={`/transactions?page=${page - 1}`}
          aria-disabled={!hasPrev}
          className={`rounded border border-zinc-300 px-3 py-1.5 dark:border-zinc-700 ${
            hasPrev ? "hover:bg-zinc-100 dark:hover:bg-zinc-900" : "pointer-events-none opacity-40"
          }`}
        >
          Previous
        </Link>
        <span className="text-zinc-500">Page {page}</span>
        <Link
          href={`/transactions?page=${page + 1}`}
          aria-disabled={!hasNext}
          className={`rounded border border-zinc-300 px-3 py-1.5 dark:border-zinc-700 ${
            hasNext ? "hover:bg-zinc-100 dark:hover:bg-zinc-900" : "pointer-events-none opacity-40"
          }`}
        >
          Next
        </Link>
      </div>
    </main>
  );
}
