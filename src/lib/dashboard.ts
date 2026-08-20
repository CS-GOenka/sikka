// Aggregation for the home dashboard.
//
// Everything here is a pure function over rows that came from
// fetchQualifyingSpendRows, so the dashboard and the daily budget push can
// never disagree about what counts as spend. Nothing in this file touches
// Supabase: the dashboard ships its ~200 qualifying rows to the browser once
// and every pill, filter and drill level is then computed locally, which is
// why switching any of them costs no round trip.
import type { PeriodKey } from "@/lib/periods";

/** Bucket key for debits that have no category yet. */
export const UNCATEGORISED = "uncategorised";
export const UNCATEGORISED_LABEL = "Uncategorised";
/** Bucket key for the folded tail of small categories. */
export const ROLLUP = "rollup";

/** A qualifying debit, trimmed to what the browser actually needs. */
export interface DashRow {
  id: number;
  amount: number;
  payee: string | null;
  /** phone_received_at, canonical UTC ISO-8601 - sortable and comparable as text. */
  at: string;
  categoryId: number | null;
}

export interface CategoryNode {
  id: number;
  name: string;
  parentId: number | null;
}

export interface PeriodWindow {
  key: PeriodKey;
  /** Label shown under the donut's centre total, e.g. "Today". */
  label: string;
  startISO: string;
  endISO: string;
  /** Start of the comparison period, for the bar chart's second series. */
  prevStartISO: string;
  prevEndISO: string;
  /** Legend label for the comparison series, e.g. "Yesterday". */
  prevLabel: string;
}

export interface Bucket {
  key: string;
  name: string;
  amount: number;
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

export function sumAmount(rows: { amount: number }[]): number {
  let total = 0;
  for (const row of rows) total += row.amount;
  return total;
}

export function rowsInWindow<T extends { at: string }>(rows: T[], window: { startISO: string; endISO: string }): T[] {
  return rows.filter((r) => r.at >= window.startISO && r.at < window.endISO);
}

// ── the category tree ────────────────────────────────────────────────────────

export interface CategoryIndex {
  name: (id: number) => string;
  /** The top-level ancestor of a category - itself, if it has no parent. */
  top: (id: number) => number;
  /** Bucket key for a row: its top-level category id, or UNCATEGORISED. */
  topKey: (categoryId: number | null) => string;
}

export function indexCategories(categories: CategoryNode[]): CategoryIndex {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const parents = new Map(categories.map((c) => [c.id, c.parentId]));
  // The schema is one level deep today, but resolving by walking rather than by
  // a single parent lookup means a grandchild category would still roll up to
  // the right top-level bucket instead of silently becoming its own slice.
  const top = (id: number): number => {
    let current = id;
    for (let guard = 0; guard < 16; guard++) {
      const parent = parents.get(current);
      if (parent == null) return current;
      current = parent;
    }
    return current;
  };
  return {
    name: (id) => names.get(id) ?? "Unknown",
    top,
    topKey: (categoryId) => (categoryId == null ? UNCATEGORISED : String(top(categoryId))),
  };
}

// ── drill scopes ─────────────────────────────────────────────────────────────

/**
 * Where the user has drilled to. `[]` is everything in the period; `["1"]` is
 * one top-level category; `["1", "21"]` is one of its subcategories. Keys are
 * the same bucket keys the chart and list are built from, so a tap on a slice
 * and a tap on a row are literally the same action.
 */
export type DrillPath = string[];

export function scopeRows(rows: DashRow[], path: DrillPath, cats: CategoryIndex): DashRow[] {
  let scoped = rows;
  if (path.length >= 1) scoped = scoped.filter((r) => cats.topKey(r.categoryId) === path[0]);
  if (path.length >= 2) scoped = scoped.filter((r) => String(r.categoryId) === path[1]);
  return scoped;
}

export function scopeLabel(path: DrillPath, cats: CategoryIndex): string[] {
  return path.map((key) => (key === UNCATEGORISED ? UNCATEGORISED_LABEL : cats.name(Number(key))));
}

/**
 * How the current scope is broken down one level further:
 *
 *   depth 0  every top-level category
 *   depth 1  the category's subcategories - or, when it has none that carry
 *            spend, the payees inside it, since a lone bucket equal to the
 *            scope itself would tell the reader nothing
 *   depth 2+ payees
 *
 * Returns `byPayee` so the caller knows whether tapping a bucket can drill any
 * further or whether this is already the bottom.
 */
export function breakdown(
  scoped: DashRow[],
  path: DrillPath,
  cats: CategoryIndex
): { buckets: Bucket[]; byPayee: boolean } {
  if (path.length === 0) {
    return { buckets: group(scoped, (r) => cats.topKey(r.categoryId), (key) =>
      key === UNCATEGORISED ? UNCATEGORISED_LABEL : cats.name(Number(key))
    ), byPayee: false };
  }
  if (path.length === 1) {
    const distinct = new Set(scoped.map((r) => String(r.categoryId)));
    if (distinct.size > 1) {
      return {
        buckets: group(scoped, (r) => String(r.categoryId), (key) => cats.name(Number(key))),
        byPayee: false,
      };
    }
  }
  return { buckets: groupByPayee(scoped), byPayee: true };
}

function group(
  rows: DashRow[],
  keyOf: (row: DashRow) => string,
  nameOf: (key: string) => string
): Bucket[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    totals.set(key, (totals.get(key) ?? 0) + row.amount);
  }
  return [...totals.entries()]
    .map(([key, amount]) => ({ key, name: nameOf(key), amount }))
    .sort(bySize);
}

function groupByPayee(rows: DashRow[]): Bucket[] {
  return group(
    rows,
    (r) => r.payee?.trim() || "Unknown payee",
    (key) => key
  );
}

// Biggest first, with Uncategorised pinned last however big it is: it is the
// odd one out in a list of categories, and the callout above the list is what
// makes its size felt.
function bySize(a: Bucket, b: Bucket): number {
  if (a.key === UNCATEGORISED) return 1;
  if (b.key === UNCATEGORISED) return -1;
  return b.amount - a.amount;
}

// ── the time axis ────────────────────────────────────────────────────────────

export type Granularity = "hour" | "day";

export interface TimeBucket {
  startMs: number;
  amount: number;
  /** The same slot one period earlier - hour 14 yesterday, last Monday, the 5th of last month. */
  prevAmount: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Even buckets tiling BOTH the current window and the comparison window, taken
 * straight from the period windows the comparison cards were built from.
 *
 * Two rules this must not break, both of which it previously did:
 *
 * 1. No qualifying row may be dropped. The bucket count is derived from the
 *    window spans, so every row inside a window necessarily lands in a bucket
 *    and the bars always sum to the total the pie and the card show. The old
 *    version derived the count from the BROWSER's Date.now(), which is not the
 *    clock the windows were computed on - anything past that instant (a phone
 *    whose clock runs fast, a tab left open) fell outside the range and was
 *    silently discarded from the bars while still counting in the total.
 *
 * 2. The comparison series must mean what the card means. The count now covers
 *    the longer of the two windows rather than truncating the comparison to the
 *    current period's elapsed length. For the week and month that changes
 *    nothing - their comparison windows are already elapsed-matched. For the
 *    day it is the whole difference between "yesterday" being the ₹17,687 the
 *    card reports and being only the couple of hours of it that today has
 *    reached so far.
 *
 * Day buckets step from the window start, which is the budget-day reset hour,
 * so a bar is one budget day - the same day the cards and the pills mean.
 */
export function timeBuckets(
  rows: DashRow[],
  prevRows: DashRow[],
  window: { startISO: string; endISO: string },
  prevWindow: { startISO: string; endISO: string },
  granularity: Granularity
): TimeBucket[] {
  const step = granularity === "hour" ? HOUR_MS : DAY_MS;
  const startMs = Date.parse(window.startISO);
  const prevStartMs = Date.parse(prevWindow.startISO);

  const spanBuckets = (w: { startISO: string; endISO: string }) =>
    Math.max(1, Math.ceil((Date.parse(w.endISO) - Date.parse(w.startISO)) / step));
  const count = Math.max(spanBuckets(window), spanBuckets(prevWindow));

  const buckets: TimeBucket[] = [];
  for (let i = 0; i < count; i++) {
    buckets.push({ startMs: startMs + i * step, amount: 0, prevAmount: 0 });
  }
  const place = (row: DashRow, origin: number, field: "amount" | "prevAmount") => {
    const i = Math.floor((Date.parse(row.at) - origin) / step);
    if (i >= 0 && i < count) buckets[i][field] += row.amount;
  };
  for (const row of rows) place(row, startMs, "amount");
  // The comparison series is bucketed off the PREVIOUS period's own start, so
  // index i means the same slot in both: hour 14 of each day, Monday of each
  // week, the 5th of each month. Pairing by wall-clock instant instead would
  // line this Monday up against last Tuesday.
  for (const row of prevRows) place(row, prevStartMs, "prevAmount");
  return buckets;
}
