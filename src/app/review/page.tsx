import { supabase } from "@/lib/supabase";
import { getAssignableCategories } from "@/lib/gemini";
import { CategoryPicker } from "@/components/CategoryPicker";

export const dynamic = "force-dynamic";

type ReviewRow = {
  id: number;
  payee: string | null;
  amount: number | null;
  currency: string;
  transaction_date: string | null;
  type: string;
  note: string | null;
  categories: { name: string } | null;
};

export default async function ReviewPage() {
  const [{ data, error }, categories] = await Promise.all([
    supabase
      .from("transactions")
      .select("id, payee, amount, currency, transaction_date, type, note, categories(name)")
      .or("needs_category_review.eq.true,and(type.in.(debit,credit),category_id.is.null)")
      .order("transaction_date", { ascending: false, nullsFirst: false })
      .returns<ReviewRow[]>(),
    getAssignableCategories(),
  ]);

  if (error) {
    return (
      <main className="p-6">
        <p className="text-red-600">Failed to load review queue: {error.message}</p>
      </main>
    );
  }

  const rows = data ?? [];

  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Needs review</h1>
      <p className="text-sm text-zinc-500">{rows.length} transaction{rows.length === 1 ? "" : "s"}</p>

      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex flex-col gap-2 rounded border border-zinc-200 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-800"
          >
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">{row.payee ?? "(no payee)"}</span>
              <span className="text-sm text-zinc-500">
                {row.transaction_date ?? "—"} · {row.type} · {row.currency} {row.amount ?? "—"}
              </span>
              {row.note && <span className="text-xs text-zinc-400">{row.note}</span>}
            </div>
            <CategoryPicker
              transactionId={row.id}
              currentCategoryName={row.categories?.name ?? null}
              categories={categories}
            />
          </div>
        ))}
        {rows.length === 0 && (
          <p className="rounded border border-zinc-200 p-6 text-center text-zinc-500 dark:border-zinc-800">
            Nothing needs review right now.
          </p>
        )}
      </div>
    </main>
  );
}
