import { supabase } from "@/lib/supabase";
import { fetchQualifyingSpendRows, getBudgetSettings } from "@/lib/budget";
import { clampOffset, dashboardFetchWindows, periodComparisons } from "@/lib/periods";
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

// The stepper lives in the URL rather than in component state: stepping to a
// month outside the fetched span needs different rows, which only the server
// can get. The pills stay client-side, so switching period is still instant and
// only stepping costs a round trip.
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function readOffset(params: Record<string, string | string[] | undefined>, key: string): number {
  const raw = Array.isArray(params[key]) ? params[key][0] : params[key];
  return clampOffset(parseInt(raw ?? "0", 10));
}

export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const endTiming = startTiming("GET /");
  try {
    return await renderDashboard(await searchParams);
  } finally {
    endTiming();
  }
}

async function renderDashboard(params: Record<string, string | string[] | undefined>) {
  const { dayResetHour } = await getBudgetSettings();
  const periods = periodComparisons(dayResetHour, {
    day: 0,
    week: readOffset(params, "wo"),
    month: readOffset(params, "mo"),
  });

  // One query per contiguous span the screen needs, rather than one per window:
  // at rest the six windows overlap into a single span, and they only separate
  // when the stepper has walked a period away from today.
  const [windowRows, { data: categoryRows, error: categoryError }] = await Promise.all([
    Promise.all(dashboardFetchWindows(periods).map(fetchQualifyingSpendRows)),
    supabase.from("categories").select("id, name, parent_id").returns<
      { id: number; name: string; parent_id: number | null }[]
    >(),
  ]);
  // Merged windows can still abut, and a row could in principle be returned by
  // two of them, so the rows are keyed by id before anything sums them.
  const spendRows = [...new Map(windowRows.flat().map((r) => [r.id, r])).values()];

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
    offset: p.offset,
    canStepForward: p.canStepForward,
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
