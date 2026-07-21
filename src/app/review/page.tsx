import { supabase } from "@/lib/supabase";
import { getAssignableCategories } from "@/lib/gemini";
import { CategoryPicker } from "@/components/CategoryPicker";
import { ReportGapButton } from "@/components/ReportGapButton";
import { startTiming } from "@/lib/timing";

export const dynamic = "force-dynamic";

type ReviewRow = {
  id: number;
  payee: string | null;
  amount: number | null;
  currency: string;
  transaction_date: string | null;
  type: string;
  note: string | null;
  needs_category_review: boolean;
  starred: boolean;
  categories: { name: string } | null;
  raw_messages: { message: string } | null;
};

export default async function ReviewPage() {
  const endTiming = startTiming("GET /review");
  try {
    return await renderReviewPage();
  } finally {
    endTiming();
  }
}

async function renderReviewPage() {
  const [{ data, error }, categories] = await Promise.all([
    supabase
      .from("transactions")
      .select(
        "id, payee, amount, currency, transaction_date, type, note, needs_category_review, starred, categories(name), raw_messages(message)"
      )
      .or("needs_category_review.eq.true,starred.eq.true")
      .eq("classifier_gap_reported", false)
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
            className="flex flex-col gap-2 rounded border border-zinc-200 p-4 sm:flex-row sm:items-start sm:justify-between dark:border-zinc-800"
          >
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {row.needs_category_review && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                    AI uncertain
                  </span>
                )}
                {row.starred && (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                    Flagged by you
                  </span>
                )}
              </div>
              <span className="font-medium">{row.payee ?? "(no payee)"}</span>
              <span className="text-sm text-zinc-500">
                {row.transaction_date ?? "—"} · {row.type} · {row.currency} {row.amount ?? "—"}
              </span>
              {row.note && <span className="text-xs text-zinc-400">{row.note}</span>}
              {row.raw_messages?.message && (
                <p className="mt-1 max-w-xl whitespace-pre-wrap rounded bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                  {row.raw_messages.message}
                </p>
              )}
            </div>
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <CategoryPicker
                transactionId={row.id}
                currentCategoryName={row.categories?.name ?? null}
                categories={categories}
              />
              <ReportGapButton transactionId={row.id} />
            </div>
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
