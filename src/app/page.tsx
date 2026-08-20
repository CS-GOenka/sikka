import { supabase } from "@/lib/supabase";
import { fetchQualifyingSpendRows, getBudgetSettings } from "@/lib/budget";
import { dashboardFetchWindow, periodComparisons } from "@/lib/periods";
import {
  bucketsInWindow,
  percentChange,
  sumInWindow,
  type ComparisonCard,
  type PeriodBreakdown,
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
  const [rows, { data: categoryRows, error: categoryError }] = await Promise.all([
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

  const categoryNames = new Map((categoryRows ?? []).map((c) => [c.id, c.name]));
  const parents = new Map((categoryRows ?? []).map((c) => [c.id, c.parent_id]));

  const cards: ComparisonCard[] = periods.map((p) => {
    const current = sumInWindow(rows, p.current);
    const previous = sumInWindow(rows, p.previous);
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

  // The pills re-scope the donut without a round trip, so all three breakdowns
  // are computed up front and switching is instant.
  const breakdowns: PeriodBreakdown[] = periods.map((p) => ({
    key: p.key,
    label: p.label,
    buckets: bucketsInWindow(rows, p.current, categoryNames, parents),
  }));

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 pb-16 pt-3">
      <h1 className="sr-only">Sikka spending dashboard</h1>
      <RefreshOnVisible />
      <ComparisonCards cards={cards} />
      <SpendExplorer periods={breakdowns} />
    </main>
  );
}
