import { supabase } from "@/lib/supabase";
import { fetchQualifyingSpendRows, getBudgetSettings } from "@/lib/budget";
import { dashboardFetchWindow, periodComparisons } from "@/lib/periods";
import {
  percentChange,
  rowsInWindow,
  sumAmount,
  type CategoryNode,
  type ComparisonCard,
  type DashRow,
  type PeriodWindow,
} from "@/lib/dashboard";
import { ComparisonCards } from "@/components/dashboard/ComparisonCards";
import { SpendExplorer } from "@/components/dashboard/SpendExplorer";
import { RefreshOnVisible } from "@/components/RefreshOnVisible";
import { startTiming } from "@/lib/timing";

export const dynamic = "force-dynamic";

export default async function Home() {
  const endTiming = startTiming("GET /");
  try {
    return await renderDashboard();
  } finally {
    endTiming();
  }
}

async function renderDashboard() {
  const { dayResetHour } = await getBudgetSettings();
  const periods = periodComparisons(dayResetHour);

  // One query for the whole screen. Every window the dashboard needs - this
  // month, last month, both weeks, both days - sits inside the span from the
  // previous month's start to the end of today, so the six totals are sliced
  // out of a single fetch in memory rather than costing six round trips.
  const [spendRows, { data: categoryRows, error: categoryError }] = await Promise.all([
    fetchQualifyingSpendRows(dashboardFetchWindow(periods)),
    supabase.from("categories").select("id, name, parent_id").returns<
      { id: number; name: string; parent_id: number | null }[]
    >(),
  ]);

  if (categoryError) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-8">
        <p className="text-sm text-[var(--sk-bad)]">
          Failed to load categories: {categoryError.message}
        </p>
      </main>
    );
  }

  const categories: CategoryNode[] = (categoryRows ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    parentId: c.parent_id,
  }));

  // A row with no receipt time can't be placed in any window, so it is dropped
  // here rather than being carried to the browser to be ignored there.
  const rows: DashRow[] = spendRows
    .filter((r): r is typeof r & { receivedAt: string } => r.receivedAt !== null)
    .map((r) => ({
      id: r.id,
      amount: r.amount,
      payee: r.payee,
      at: r.receivedAt,
      categoryId: r.categoryId,
    }));

  const cards: ComparisonCard[] = periods.map((p) => {
    const current = sumAmount(rowsInWindow(rows, p.current));
    const previous = sumAmount(rowsInWindow(rows, p.previous));
    return {
      key: p.key,
      label: p.label,
      comparisonLabel: p.comparisonLabel,
      comparisonDetail: p.comparisonDetail,
      current,
      previous,
      deltaPct: percentChange(current, previous),
    };
  });

  // The pills, the filter, the chart toggle and every drill level are computed
  // in the browser from these rows, so none of them costs a round trip. At
  // roughly 200 rows for a two-month span that payload is a few tens of KB.
  const periodWindows: PeriodWindow[] = periods.map((p) => ({
    key: p.key,
    label: p.label,
    startISO: p.current.startISO,
    endISO: p.current.endISO,
    prevStartISO: p.previous.startISO,
    prevEndISO: p.previous.endISO,
    prevLabel: p.comparisonName,
  }));

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 pb-16 pt-3">
      <h1 className="sr-only">Sikka spending dashboard</h1>
      <RefreshOnVisible />
      <ComparisonCards cards={cards} />
      <SpendExplorer rows={rows} categories={categories} periods={periodWindows} />
    </main>
  );
}
