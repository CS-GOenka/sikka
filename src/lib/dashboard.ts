// Aggregation for the home dashboard. Everything here works on the rows
// returned by fetchQualifyingSpendRows, so the dashboard and the daily budget
// push can never disagree about what counts as spend.
import type { SpendRow } from "@/lib/budget";
import type { PeriodKey, Window } from "@/lib/periods";

/** Bucket key for debits that have no category yet. */
export const UNCATEGORISED = "uncategorised";
export const UNCATEGORISED_LABEL = "Uncategorised";

export interface Bucket {
  /** Top-level category id as a string, or UNCATEGORISED. */
  key: string;
  name: string;
  amount: number;
}

export interface PeriodBreakdown {
  key: PeriodKey;
  /** Label shown under the donut's centre total, e.g. "Today". */
  label: string;
  buckets: Bucket[];
}

export interface ComparisonCard {
  key: PeriodKey;
  label: string;
  comparisonLabel: string;
  comparisonDetail: string;
  current: number;
  previous: number;
  /**
   * Whole-number % change vs the comparison period; null when the comparison
   * period had no spend at all, where a % is undefined rather than infinite.
   * Positive = spent MORE this period.
   */
  deltaPct: number | null;
}

export type Tone = "bad" | "good" | "flat" | "none";

/**
 * The colour rule, stated once so it cannot drift: spending MORE than the
 * comparison period is bad (red), spending LESS is good (green), dead level is
 * yellow. Read from the *rounded* percentage, so a card showing "0%" is never
 * painted red by a rounding remainder.
 */
export function deltaTone(deltaPct: number | null): Tone {
  if (deltaPct === null) return "none";
  if (deltaPct > 0) return "bad";
  if (deltaPct < 0) return "good";
  return "flat";
}

export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 100);
}

function inWindow(row: SpendRow, window: Window): boolean {
  if (!row.receivedAt) return false;
  return row.receivedAt >= window.startISO && row.receivedAt < window.endISO;
}

export function sumInWindow(rows: SpendRow[], window: Window): number {
  let total = 0;
  for (const row of rows) if (inWindow(row, window)) total += row.amount;
  return total;
}

/**
 * Spend per *top-level* category within a window: a subcategory's spend is
 * rolled into its parent, because the parents are what the donut's segments
 * mean and what Pass 2 will drill down from. Sorted by amount descending, with
 * Uncategorised always last regardless of size - it is the odd one out in the
 * list, and the callout above the list is what makes its size felt.
 */
export function bucketsInWindow(
  rows: SpendRow[],
  window: Window,
  categoryNames: Map<number, string>,
  parents: Map<number, number | null>
): Bucket[] {
  const totals = new Map<string, { name: string; amount: number }>();
  for (const row of rows) {
    if (!inWindow(row, window)) continue;
    let key = UNCATEGORISED;
    let name = UNCATEGORISED_LABEL;
    if (row.categoryId != null) {
      const topId = parents.get(row.categoryId) ?? row.categoryId;
      key = String(topId);
      // Falls back to the row's own name if the parent somehow isn't in the
      // category table - a bucket with a wrong label still beats a lost total.
      name = categoryNames.get(topId) ?? row.categoryName ?? "Unknown";
    }
    const entry = totals.get(key);
    if (entry) entry.amount += row.amount;
    else totals.set(key, { name, amount: row.amount });
  }
  return [...totals.entries()]
    .map(([key, v]) => ({ key, name: v.name, amount: v.amount }))
    .sort((a, b) => {
      if (a.key === UNCATEGORISED) return 1;
      if (b.key === UNCATEGORISED) return -1;
      return b.amount - a.amount;
    });
}
