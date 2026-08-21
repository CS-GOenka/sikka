"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ROLLUP,
  UNCATEGORISED,
  UNCATEGORISED_LABEL,
  breakdown,
  deltaTone,
  indexCategories,
  percentChange,
  rowsInWindow,
  scopeLabel,
  scopeRows,
  sumAmount,
  timeBuckets,
  type Bucket,
  type CategoryNode,
  type DashRow,
  type DrillPath,
  type Granularity,
  type PeriodWindow,
} from "@/lib/dashboard";
import type { PeriodKey } from "@/lib/periods";
import {
  ROLLUP_COLOR,
  SERIES_COMPARISON,
  SERIES_CURRENT,
  UNCATEGORISED_COLOR,
  buildCategoryPalette,
  readableInkOn,
  type CategoryPalette,
} from "@/lib/categoryColors";
import { PeriodStepper } from "@/components/dashboard/PeriodStepper";
import { formatInr } from "@/lib/formatInr";
import { istDateTime } from "@/lib/formatIst";
import { TimeBars, bucketReadout, type AxisMode } from "@/components/dashboard/TimeBars";
import { BucketCompare, type TowerSegment } from "@/components/dashboard/BucketCompare";
import { TransactionSheet } from "@/components/dashboard/TransactionSheet";

// Past this many named slices the ring stops being readable and the tail goes
// into a rollup - which is then sorted back into place by size like any other
// slice, so "darker = bigger" stays true.
const MAX_NAMED_SLICES = 6;
/** Rows shown in the detail list before it asks to be expanded. */
const DEFAULT_LIST_ROWS = 8;

const PILLS: { key: PeriodKey; label: string }[] = [
  { key: "day", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
];

// Uncategorised share thresholds. Starting points, meant to be tuned: under
// CALM it is background noise, past ALARM it is distorting every number on the
// screen and should be impossible to ignore.
const CALM_BELOW_PCT = 10;
const ALARM_AT_PCT = 25;

type ChartMode = "donut" | "time";

interface Slice extends Bucket {
  color: string;
  share: number;
}

// A share that rounds to 0 but isn't 0 must not print "0%" next to a non-zero
// rupee figure - the two would contradict each other on the same line.
function formatShare(share: number): string {
  if (share > 0 && share < 0.5) return "<1%";
  return `${Math.round(share)}%`;
}

export function SpendExplorer({
  rows,
  categories,
  periods,
}: {
  rows: DashRow[];
  categories: CategoryNode[];
  periods: PeriodWindow[];
}) {
  const [period, setPeriod] = useState<PeriodKey>("day");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [path, setPath] = useState<DrillPath>([]);
  const [mode, setMode] = useState<ChartMode>("donut");
  const [selectedBar, setSelectedBar] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Two-stage segment interaction: the first tap selects a slice (and takes
  // over the centre label), the second drills into it. Drilling straight off
  // one tap made it far too easy to fall a level deeper than intended, with
  // nothing in between that just answers "how much was that one?".
  const [selectedSlice, setSelectedSlice] = useState<string | null>(null);
  const [openTransaction, setOpenTransaction] = useState<DashRow | null>(null);
  // A second tap on an already-selected bar opens that slot up.
  const [zoomedBar, setZoomedBar] = useState<number | null>(null);

  const cats = useMemo(() => indexCategories(categories), [categories]);
  // One shared map, built once: the donut, the bars and the detail list all
  // read a category's colour from here, so they can never disagree.
  const palette = useMemo(() => buildCategoryPalette(categories), [categories]);
  const window = periods.find((p) => p.key === period) ?? periods[0];

  // Anything that changes what is on screen also invalidates a bar selection
  // and a "show all" - resetting them in the handlers rather than in an effect
  // keeps the render a pure function of state.
  function reset<T>(setter: (v: T) => void) {
    return (value: T) => {
      setter(value);
      setSelectedBar(null);
      setSelectedSlice(null);
      setZoomedBar(null);
      setExpanded(false);
    };
  }

  const periodRows = useMemo(
    () => rowsInWindow(rows, window).filter((r) => !hidden.has(cats.topKey(r.categoryId))),
    [rows, window, hidden, cats]
  );
  const scoped = useMemo(() => scopeRows(periodRows, path, cats), [periodRows, path, cats]);
  const total = useMemo(() => sumAmount(scoped), [scoped]);

  const { buckets, byPayee } = useMemo(() => breakdown(scoped, path, cats), [scoped, path, cats]);

  // The category the whole screen is currently scoped to - the deepest crumb
  // that is a real category. Drives the bar chart's hue and the payee shades.
  const scopeCategoryId = useMemo(() => {
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i] !== UNCATEGORISED) return Number(path[i]);
    }
    return null;
  }, [path]);

  const slices = useMemo(
    () => buildSlices(buckets, total, palette, scopeCategoryId, byPayee),
    [buckets, total, palette, scopeCategoryId, byPayee]
  );

  const crumbs = useMemo(() => scopeLabel(path, cats), [path, cats]);
  const scopeName = crumbs.length > 0 ? crumbs[crumbs.length - 1] : window.label;

  // Every top-level category in any period, so hiding one on "Today" keeps it
  // hidden when the pill moves to "This month" and it reappears in the data.
  const allTopLevel = useMemo(() => topLevelOptions(rows, cats), [rows, cats]);

  const granularity: Granularity = period === "day" ? "hour" : "day";
  // The comparison series is scoped and filtered exactly like the current one,
  // so the pair is genuinely like-for-like.
  const prevScoped = useMemo(() => {
    if (mode !== "time") return [];
    const inPrev = rows.filter(
      (r) =>
        r.at >= window.prevStartISO &&
        r.at < window.prevEndISO &&
        !hidden.has(cats.topKey(r.categoryId))
    );
    return scopeRows(inPrev, path, cats);
  }, [mode, rows, window, hidden, cats, path]);

  const bars = useMemo(
    () =>
      mode === "time"
        ? timeBuckets(
            scoped,
            prevScoped,
            window,
            { startISO: window.prevStartISO, endISO: window.prevEndISO },
            granularity
          )
        : [],
    [mode, scoped, prevScoped, window, granularity]
  );
  const activeBar = selectedBar !== null && selectedBar < bars.length ? selectedBar : null;
  const zoomed = zoomedBar !== null && zoomedBar < bars.length ? bars[zoomedBar] : null;

  const axis: { mode: AxisMode; title: string } =
    period === "day"
      ? { mode: "hour", title: "Hour of day" }
      : period === "week"
        ? { mode: "weekday", title: "Day of week" }
        : { mode: "dayOfMonth", title: "Day of month" };

  // The same comparison the cards make, for whatever the screen is scoped to -
  // reusing percentChange and deltaTone so the sign and the colour rule cannot
  // drift from the cards above.
  const prevTotal = useMemo(() => sumAmount(prevScoped), [prevScoped]);
  const deltaPct = percentChange(total, prevTotal);
  const tone = deltaTone(deltaPct);

  // The category split behind one slot, for both periods, on whatever drill
  // level the user is already at - so zooming into a day inside "Food & Dining"
  // splits by its subcategories rather than jumping back to top-level ones.
  const zoomSegments: TowerSegment[] = useMemo(() => {
    if (!zoomed) return [];
    const step = granularity === "hour" ? 3_600_000 : 86_400_000;
    // The comparison slot is the same offset into the previous window, which is
    // how the paired bars line up in the chart this zooms out from.
    const prevStart =
      Date.parse(window.prevStartISO) + (zoomed.startMs - Date.parse(window.startISO));
    const slice = (rows: DashRow[], from: number) =>
      rows.filter((r) => {
        const t = Date.parse(r.at);
        return t >= from && t < from + step;
      });
    const cur = breakdown(slice(scoped, zoomed.startMs), path, cats).buckets;
    const prev = breakdown(slice(prevScoped, prevStart), path, cats).buckets;
    const prevBy = new Map(prev.map((b) => [b.key, b.amount]));
    const names = new Map<string, string>();
    for (const b of [...cur, ...prev]) if (!names.has(b.key)) names.set(b.key, b.name);
    return [...names.entries()].map(([key, name]) => ({
      key,
      name,
      current: cur.find((b) => b.key === key)?.amount ?? 0,
      previous: prevBy.get(key) ?? 0,
    }));
  }, [zoomed, scoped, prevScoped, window, granularity, path, cats]);

  const uncategorised = buckets.find((b) => b.key === UNCATEGORISED)?.amount ?? 0;
  const uncategorisedShare = total > 0 ? (uncategorised / total) * 100 : 0;

  function drillTo(key: string) {
    if (key === ROLLUP) {
      // The rollup is a drawing device, not a place - tapping it opens up the
      // list it stands for rather than pretending to be a category.
      setExpanded(true);
      return;
    }
    if (byPayee) return; // already at transactions
    reset(setPath)([...path, key]);
  }

  // First tap selects, second tap on the same slice drills. The detail rows
  // below go straight to the drill, since a row already names and values its
  // category - there is nothing for a select step to reveal there.
  function tapSlice(key: string | null) {
    // Anywhere that isn't a segment - the hole, the space beside the ring -
    // clears the selection. Without it a selected slice could only be swapped
    // for another one, never simply put down.
    if (key === null) {
      setSelectedSlice(null);
      return;
    }
    if (key === ROLLUP) {
      setExpanded(true);
      return;
    }
    if (selectedSlice === key) drillTo(key);
    else setSelectedSlice(key);
  }

  const activeSlice = slices.find((s) => s.key === selectedSlice) ?? null;

  // The headline is always the total for what the pills select - the same
  // number the pie centres and the comparison card show. A tapped bar is
  // reported on its own line underneath rather than replacing it: swapping the
  // hero number for one bucket's amount left the screen showing a figure that
  // contradicted the selected pill.
  const selectedBucket = activeBar !== null ? bars[activeBar] : null;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <FilterControl buckets={allTopLevel} hidden={hidden} onHidden={reset(setHidden)} />
        <div
          role="tablist"
          aria-label="Time period"
          className="flex min-w-0 flex-1 gap-1 rounded-full border border-[var(--sk-hair)] bg-[var(--sk-surface)] p-1"
        >
          {PILLS.map((pill) => {
            const active = pill.key === period;
            return (
              <button
                key={pill.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => reset(setPeriod)(pill.key)}
                className={`min-w-0 flex-1 truncate rounded-full px-2 py-2 text-[0.8125rem] font-medium transition-colors ${
                  active
                    ? "bg-[var(--sk-accent)] text-[var(--sk-accent-on)] ring-1 ring-[var(--sk-accent-edge)]"
                    : "text-[var(--sk-ink-3)] active:bg-[var(--sk-plane)]"
                }`}
              >
                {pill.label}
              </button>
            );
          })}
        </div>
      </div>

      {period !== "day" && (
        <PeriodStepper
          paramKey={period === "week" ? "wo" : "mo"}
          offset={window.offset}
          label={window.label}
          canStepForward={window.canStepForward}
        />
      )}

      <div className="rounded-3xl border border-[var(--sk-hair)] bg-[var(--sk-surface)] p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <BackButton
            crumbs={crumbs}
            onBack={() => reset(setPath)(path.slice(0, path.length - 1))}
          />
          <ChartToggle mode={mode} onMode={reset(setMode)} />
        </div>

        {mode === "donut" ? (
          <Donut
            slices={slices}
            total={total}
            value={activeSlice ? activeSlice.amount : total}
            label={activeSlice ? activeSlice.name : scopeName}
            sublabel={
              activeSlice
                ? `${formatShare(activeSlice.share)} of ${scopeName}`
                : crumbs.length > 0
                  ? window.label
                  : null
            }
            hint={activeSlice && !byPayee ? "Tap again to open" : null}
            filtered={hidden.size > 0}
            selectedKey={selectedSlice}
            onTap={tapSlice}
          />
        ) : zoomed ? (
          <div>
            <div className="mb-4">
              <button
                type="button"
                onClick={() => setZoomedBar(null)}
                className="flex items-center gap-1.5 rounded-full border border-[var(--sk-accent-edge)] bg-[var(--sk-accent)] px-3.5 py-2 text-[0.8125rem] font-semibold text-[var(--sk-accent-on)] active:brightness-95"
              >
                <span aria-hidden className="text-base leading-none">←</span>
                {window.label}
              </button>
            </div>
            <h3 className="text-[1.0625rem] font-semibold text-[var(--sk-ink)]">
              {bucketReadout(zoomed, granularity)}
            </h3>
            <p className="mb-4 mt-0.5 text-[0.8125rem] text-[var(--sk-ink-3)]">
              Split by category, same slot in both periods
            </p>
            <BucketCompare
              segments={zoomSegments}
              currentLabel={window.label}
              comparisonLabel={window.prevLabel}
              currentTotal={zoomed.amount}
              previousTotal={zoomed.prevAmount}
            />
          </div>
        ) : (
          <div>
            <div className="mb-4">
              {/* The headline in this view is the CHANGE, not the total: the
                  chart is a comparison of two periods, so the number that
                  answers it is the difference between them. Both totals stay
                  underneath, since a percentage with nothing behind it is not
                  a number anybody can check. */}
              <div
                className={`flex items-baseline gap-2 text-[2rem] font-semibold leading-none tracking-tight tabular-nums ${
                  deltaPct === null
                    ? "text-[var(--sk-ink-3)]"
                    : tone === "bad"
                      ? "text-[var(--sk-bad)]"
                      : tone === "good"
                        ? "text-[var(--sk-good)]"
                        : "text-[var(--sk-warn)]"
                }`}
              >
                <span aria-hidden>
                  {deltaPct === null ? "" : tone === "bad" ? "↑" : tone === "good" ? "↓" : "→"}
                </span>
                <span>{deltaPct === null ? "new" : `${Math.abs(deltaPct)}%`}</span>
                <span className="text-[0.9375rem] font-medium text-[var(--sk-ink-2)]">
                  {deltaPct === null
                    ? `nothing in ${window.prevLabel}`
                    : tone === "bad"
                      ? "more"
                      : tone === "good"
                        ? "less"
                        : "level"}
                </span>
              </div>
              <p className="mt-2 text-[0.8125rem] tabular-nums text-[var(--sk-ink-2)]">
                <span className="font-semibold text-[var(--sk-ink)]">{formatInr(total)}</span>
                <span className="text-[var(--sk-ink-3)]">
                  {" "}
                  {scopeName} · vs {formatInr(prevTotal)} {window.prevLabel}
                </span>
              </p>
              {selectedBucket && (
                <div className="mt-2 flex flex-wrap items-baseline gap-x-2 text-[0.8125rem]">
                  <span className="font-semibold text-[var(--sk-ink)]">
                    {bucketReadout(selectedBucket, granularity)}
                  </span>
                  <span className="tabular-nums text-[var(--sk-ink-2)]">
                    {formatInr(selectedBucket.amount)}
                  </span>
                  <span className="tabular-nums text-[var(--sk-ink-3)]">
                    · {window.prevLabel} {formatInr(selectedBucket.prevAmount)}
                  </span>
                  <span className="font-medium text-[var(--sk-accent-ink)]">Tap again to open</span>
                </div>
              )}
            </div>
            <TimeBars
              buckets={bars}
              granularity={granularity}
              axisMode={axis.mode}
              axisTitle={axis.title}
              currentColor={SERIES_CURRENT}
              comparisonColor={SERIES_COMPARISON}
              currentLabel={crumbs.length > 0 ? `${scopeName} · ${window.label}` : window.label}
              comparisonLabel={window.prevLabel}
              selected={activeBar}
              onSelect={setSelectedBar}
              onZoom={setZoomedBar}
            />
          </div>
        )}

        {/* The callout is about the whole period, so it stays out of a view
            scoped to one category or one slot of it. */}
        {path.length === 0 && !zoomed && (
          <UncategorisedCallout
            amount={uncategorised}
            share={uncategorisedShare}
            hasSpend={total > 0}
          />
        )}
      </div>

      <DetailPanel
        slices={slices}
        buckets={buckets}
        rows={scoped}
        showTransactions={byPayee}
        scopeName={scopeName}
        periodLabel={window.label}
        expanded={expanded}
        onExpand={() => setExpanded(true)}
        onDrill={drillTo}
        onOpenTransaction={setOpenTransaction}
      />

      {openTransaction && (
        <TransactionSheet
          row={openTransaction}
          categoryName={
            openTransaction.categoryId == null
              ? UNCATEGORISED_LABEL
              : cats.name(openTransaction.categoryId)
          }
          onClose={() => setOpenTransaction(null)}
        />
      )}
    </section>
  );
}

/**
 * Top slices by amount, tail folded into a rollup, uncategorised pinned last in
 * neutral grey. The named slices are re-sorted *after* folding so the ramp's
 * darkest step always belongs to the biggest slice on screen.
 */
function buildSlices(
  buckets: Bucket[],
  total: number,
  palette: CategoryPalette,
  scopeCategoryId: number | null,
  byPayee: boolean
): Slice[] {
  const named = buckets.filter((b) => b.key !== UNCATEGORISED);
  const uncategorised = buckets.find((b) => b.key === UNCATEGORISED);

  const head = named.slice(0, MAX_NAMED_SLICES);
  const tail = named.slice(MAX_NAMED_SLICES);
  if (tail.length > 0) {
    head.push({
      // Not "Other": there is a real category by that name, and two rows
      // reading "Other" in the same list would be indistinguishable.
      key: ROLLUP,
      name: `+${tail.length} more`,
      amount: sumAmount(tail),
    });
  }
  head.sort((a, b) => b.amount - a.amount);

  // Payee buckets aren't categories, so they have no colour of their own: they
  // take shades of whichever category the user drilled into, which keeps the
  // ring reading as one family rather than as a new palette appearing at the
  // bottom of the path.
  const payeeShades = byPayee ? palette.shades(scopeCategoryId, head.length) : [];

  const slices: Slice[] = head.map((b, i) => ({
    ...b,
    color:
      b.key === ROLLUP
        ? ROLLUP_COLOR
        : byPayee
          ? payeeShades[i]
          : palette.color(Number(b.key)),
    share: total > 0 ? (b.amount / total) * 100 : 0,
  }));
  if (uncategorised && uncategorised.amount > 0) {
    slices.push({
      ...uncategorised,
      color: UNCATEGORISED_COLOR,
      share: total > 0 ? (uncategorised.amount / total) * 100 : 0,
    });
  }
  return slices;
}

function topLevelOptions(rows: DashRow[], cats: ReturnType<typeof indexCategories>) {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const key = cats.topKey(row.categoryId);
    if (!seen.has(key)) {
      seen.set(key, key === UNCATEGORISED ? UNCATEGORISED_LABEL : cats.name(Number(key)));
    }
  }
  return [...seen.entries()]
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => {
      if (a.key === UNCATEGORISED) return 1;
      if (b.key === UNCATEGORISED) return -1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Getting back out of a drill-down. A breadcrumb trail was too quiet to find on
 * a phone - this is a real button, it names where it goes rather than where you
 * are, and it is present the whole time you are below the top level.
 */
function BackButton({ crumbs, onBack }: { crumbs: string[]; onBack: () => void }) {
  if (crumbs.length === 0) {
    return <span className="truncate text-[0.9375rem] font-semibold text-[var(--sk-ink)]">All spend</span>;
  }
  const parent = crumbs.length === 1 ? "All categories" : crumbs[crumbs.length - 2];
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex min-w-0 items-center gap-1.5 rounded-full border border-[var(--sk-accent-edge)] bg-[var(--sk-accent)] px-3.5 py-2 text-[0.8125rem] font-semibold text-[var(--sk-accent-on)] transition-colors active:brightness-95"
    >
      <span aria-hidden className="text-base leading-none">←</span>
      <span className="truncate">{parent}</span>
    </button>
  );
}

function ChartToggle({ mode, onMode }: { mode: ChartMode; onMode: (m: ChartMode) => void }) {
  return (
    <div
      role="group"
      aria-label="Chart type"
      className="flex shrink-0 gap-0.5 rounded-full border border-[var(--sk-hair)] p-0.5"
    >
      <ToggleButton active={mode === "donut"} onClick={() => onMode("donut")} label="By category">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="3.2" />
      </ToggleButton>
      <ToggleButton active={mode === "time"} onClick={() => onMode("time")} label="Over time">
        <path d="M3 13V8M8 13V3.5M13 13v-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </ToggleButton>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`flex size-8 items-center justify-center rounded-full transition-colors ${
        active
          ? "bg-[var(--sk-accent)] text-[var(--sk-accent-on)] ring-1 ring-[var(--sk-accent-edge)]"
          : "text-[var(--sk-ink-3)]"
      }`}
    >
      <svg viewBox="0 0 16 16" aria-hidden className="size-4">
        {children}
      </svg>
    </button>
  );
}

function FilterControl({
  buckets,
  hidden,
  onHidden,
}: {
  buckets: { key: string; name: string }[];
  hidden: ReadonlySet<string>;
  onHidden: (next: ReadonlySet<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  function toggle(key: string) {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onHidden(next);
  }

  const active = hidden.size > 0;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={active ? `Filter categories (${hidden.size} hidden)` : "Filter categories"}
        onClick={() => setOpen((v) => !v)}
        className={`flex size-10 items-center justify-center rounded-full border transition-colors ${
          active
            ? "border-[var(--sk-accent-edge)] bg-[var(--sk-accent-tint)] text-[var(--sk-accent-ink)]"
            : "border-[var(--sk-hair)] bg-[var(--sk-surface)] text-[var(--sk-ink-3)]"
        }`}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden className="size-[1.125rem]">
          <path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
      {active && (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-[var(--sk-accent)] text-[0.5625rem] font-bold text-[var(--sk-accent-on)] ring-1 ring-[var(--sk-accent-edge)]"
        >
          {hidden.size}
        </span>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Filter categories"
          className="absolute left-0 z-40 mt-2 max-h-80 w-64 overflow-y-auto overscroll-contain rounded-2xl border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] p-2 shadow-[0_12px_32px_-8px_rgba(28,25,23,0.18)]"
        >
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--sk-ink-3)]">
              Categories
            </span>
            <button
              type="button"
              onClick={() => onHidden(new Set())}
              disabled={!active}
              className="text-xs font-medium text-[var(--sk-accent-ink)] disabled:text-[var(--sk-ink-3)] disabled:opacity-50"
            >
              Reset
            </button>
          </div>
          {buckets.map((b) => (
            <label
              key={b.key}
              className="flex items-center gap-2.5 rounded-xl px-2 py-2 text-sm text-[var(--sk-ink-2)] active:bg-[var(--sk-plane)]"
            >
              <input
                type="checkbox"
                checked={!hidden.has(b.key)}
                onChange={() => toggle(b.key)}
                className="size-4 accent-[var(--sk-accent-ink)]"
              />
              <span className="truncate">{b.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// Donut geometry. The ring is drawn as dashed circle strokes rather than arc
// paths so the 2px surface gap between neighbouring slices comes for free from
// shortening each dash - no overlapping outlines to fight with.
const SIZE = 200;
const RADIUS = 74;
const THICKNESS = 30;
const GAP = 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function Donut({
  slices,
  total,
  value,
  label,
  sublabel,
  hint,
  filtered,
  selectedKey,
  onTap,
}: {
  slices: Slice[];
  total: number;
  value: number;
  label: string;
  sublabel: string | null;
  hint: string | null;
  filtered: boolean;
  selectedKey: string | null;
  onTap: (key: string | null) => void;
}) {
  let offset = 0;
  const arcs = slices.map((slice) => {
    const length = total > 0 ? (slice.amount / total) * CIRCUMFERENCE : 0;
    const arc = { slice, length, offset };
    offset += length;
    return arc;
  });

  return (
    // The deselect target is this whole block, not just the ring's hole, so a
    // thumb landing in the space beside the donut puts the selection down too.
    <div
      onClick={() => onTap(null)}
      className={`w-full ${selectedKey ? "cursor-pointer" : ""}`}
    >
    <div className="relative mx-auto w-full max-w-[17.5rem]">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-full overflow-visible"
        role="img"
        aria-label={`Spend breakdown, ${label}: ${formatInr(value)} total`}
      >
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="var(--sk-plane)" strokeWidth={THICKNESS} />
        {total > 0 &&
          arcs.map(({ slice, length, offset: start }) => {
            const isSelected = slice.key === selectedKey;
            return (
              <circle
                key={slice.key}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke={slice.color}
                // The selected slice grows outward and its neighbours fade -
                // the same read as a hover state, which is the cue a phone
                // otherwise has no way to give.
                strokeWidth={isSelected ? THICKNESS + 10 : THICKNESS}
                opacity={selectedKey && !isSelected ? 0.4 : 1}
                strokeDasharray={`${Math.max(length - GAP, 1)} ${CIRCUMFERENCE}`}
                strokeDashoffset={-start}
                transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
                onClick={(e) => {
                  e.stopPropagation();
                  onTap(slice.key);
                }}
                className="cursor-pointer"
              >
                <title>{`${slice.name}: ${formatInr(slice.amount)} (${formatShare(slice.share)})`}</title>
              </circle>
            );
          })}

        {/* Share labels sit on the ring itself. Only where the slice is wide
            enough to hold one - below that the labels collide with each other
            and with the gaps, and the detail list already carries every value
            in text. Ink is picked from the fill's luminance, so a label is
            legible on a pale slice and on a dark one alike. */}
        {total > 0 &&
          arcs.map(({ slice, length, offset: start }) => {
            if (slice.share < 7) return null;
            const midAngle = ((start + length / 2) / CIRCUMFERENCE) * 360 - 90;
            const rad = (midAngle * Math.PI) / 180;
            return (
              <text
                key={`${slice.key}-pct`}
                x={SIZE / 2 + RADIUS * Math.cos(rad)}
                y={SIZE / 2 + RADIUS * Math.sin(rad)}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={slice.key === selectedKey ? 12 : 11}
                fontWeight={600}
                fill={readableInkOn(slice.color)}
                opacity={selectedKey && slice.key !== selectedKey ? 0.5 : 1}
                pointerEvents="none"
              >
                {Math.round(slice.share)}%
              </text>
            );
          })}
      </svg>

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-12 text-center">
        <span className="text-[1.75rem] font-semibold leading-none tracking-tight tabular-nums text-[var(--sk-ink)]">
          {formatInr(value)}
        </span>
        <span className="mt-1.5 line-clamp-2 text-[0.8125rem] text-[var(--sk-ink-3)]">{label}</span>
        {sublabel && <span className="mt-0.5 text-[0.6875rem] text-[var(--sk-ink-3)]">{sublabel}</span>}
        {hint && (
          <span className="mt-1 text-[0.6875rem] font-medium text-[var(--sk-accent-ink)]">{hint}</span>
        )}
        {filtered && (
          <span className="mt-0.5 text-[0.6875rem] font-medium text-[var(--sk-accent-ink)]">filtered</span>
        )}
      </div>
    </div>
    </div>
  );
}

/**
 * Uncategorised spend as a share of the period's total, styled to escalate:
 * calm and quiet when it is a rounding error, insistent when it is big enough
 * to make every other number on this screen wrong. Kept deliberately smaller
 * and lighter than the chart's headline total - it is a sub-metric, not a rival
 * headline.
 */
function UncategorisedCallout({
  amount,
  share,
  hasSpend,
}: {
  amount: number;
  share: number;
  hasSpend: boolean;
}) {
  if (!hasSpend) return null;

  const level = amount === 0 || share < CALM_BELOW_PCT ? "calm" : share < ALARM_AT_PCT ? "caution" : "alarm";
  const styles = {
    calm: "border-transparent bg-[var(--sk-good-tint)] text-[var(--sk-good)]",
    caution: "border-transparent bg-[var(--sk-warn-tint)] text-[var(--sk-warn)]",
    alarm: "border-[var(--sk-bad)]/25 bg-[var(--sk-bad-tint)] text-[var(--sk-bad)]",
  }[level];

  return (
    <Link
      href="/review"
      className={`mt-4 flex items-center justify-between gap-3 rounded-2xl border px-3.5 py-2.5 transition-colors ${styles}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <StatusIcon level={level} />
        <span className={`truncate text-[0.8125rem] ${level === "alarm" ? "font-semibold" : ""}`}>
          {amount === 0 ? (
            "Everything categorised"
          ) : (
            <>
              <span className="tabular-nums">{formatShare(share)}</span> uncategorised ·{" "}
              <span className="tabular-nums">{formatInr(amount)}</span>
            </>
          )}
        </span>
      </span>
      <span className="shrink-0 text-[0.75rem] font-medium opacity-80">Review →</span>
    </Link>
  );
}

// Status colour never carries the meaning on its own - each level ships with
// its own mark as well as its own hue.
function StatusIcon({ level }: { level: "calm" | "caution" | "alarm" }) {
  if (level === "calm") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0">
        <path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0">
      <path d="M8 2.5l6 11H2l6-11z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 6.5v3.2M8 11.6v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The panel below the chart. It is also the chart's legend and its table view,
 * so every slice is named and valued in text and nothing depends on telling two
 * browns apart. At the bottom of a drill path it switches from buckets to the
 * individual transactions behind them.
 */
function DetailPanel({
  slices,
  buckets,
  rows,
  showTransactions,
  scopeName,
  periodLabel,
  expanded,
  onExpand,
  onDrill,
  onOpenTransaction,
}: {
  slices: Slice[];
  buckets: Bucket[];
  rows: DashRow[];
  showTransactions: boolean;
  scopeName: string;
  periodLabel: string;
  expanded: boolean;
  onExpand: () => void;
  onDrill: (key: string) => void;
  onOpenTransaction: (row: DashRow) => void;
}) {
  // A bucket that was folded into the rollup wears the rollup's colour: the
  // swatch says "this is part of that slice", which is true.
  const colorOf = useMemo(() => {
    const exact = new Map(slices.map((s) => [s.key, s.color]));
    const rollup = exact.get(ROLLUP) ?? ROLLUP_COLOR;
    return (key: string) => exact.get(key) ?? rollup;
  }, [slices]);

  const transactions = useMemo(
    () => [...rows].sort((a, b) => b.at.localeCompare(a.at)),
    [rows]
  );

  const items = showTransactions ? transactions : buckets;
  const shown = expanded ? items.length : Math.min(items.length, DEFAULT_LIST_ROWS);
  const hiddenCount = items.length - shown;
  const max = buckets.reduce((m, b) => Math.max(m, b.amount), 0);
  const total = sumAmount(buckets);

  return (
    <div className="rounded-3xl border border-[var(--sk-hair)] bg-[var(--sk-surface)] p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="min-w-0 truncate text-[0.9375rem] font-semibold text-[var(--sk-ink)]">
          {showTransactions ? "Transactions" : scopeName === periodLabel ? "Top categories" : scopeName}
        </h2>
        <span className="shrink-0 text-xs text-[var(--sk-ink-3)]">{periodLabel}</span>
      </div>

      {items.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--sk-ink-3)]">No spend in this period.</p>
      ) : (
        <>
          <ul className="mt-3 flex flex-col">
            {showTransactions
              ? transactions.slice(0, shown).map((row) => (
                  <li key={row.id} className="border-b border-[var(--sk-hair)] last:border-b-0">
                    <button
                      type="button"
                      onClick={() => onOpenTransaction(row)}
                      className="flex w-full items-center gap-2.5 py-2.5 text-left active:bg-[var(--sk-plane)]"
                    >
                      <span
                        aria-hidden
                        // Keyed to the payee's slice, so the ring above and the
                        // rows below are readable as one thing: at this depth the
                        // chart's segments are payees, and without this the
                        // slices would have no label anywhere in text.
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ background: colorOf(row.payee?.trim() || "Unknown payee") }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-[var(--sk-ink)]">
                          {row.payee?.trim() || "Unknown payee"}
                        </span>
                        <span className="block text-xs tabular-nums text-[var(--sk-ink-3)]">
                          {istDateTime(Date.parse(row.at))}
                        </span>
                      </span>
                      {row.starred && (
                        <span aria-label="Flagged for review" className="shrink-0 text-[var(--sk-accent-ink)]">
                          ★
                        </span>
                      )}
                      <span className="shrink-0 text-sm font-medium tabular-nums text-[var(--sk-ink)]">
                        {formatInr(row.amount)}
                      </span>
                      <span aria-hidden className="shrink-0 text-[var(--sk-ink-3)]">
                        ›
                      </span>
                    </button>
                  </li>
                ))
              : buckets.slice(0, shown).map((bucket) => (
                  <li key={bucket.key} className="border-b border-[var(--sk-hair)] last:border-b-0">
                    <button
                      type="button"
                      onClick={() => onDrill(bucket.key)}
                      className="w-full py-2.5 text-left active:bg-[var(--sk-plane)]"
                    >
                      <div className="flex items-center gap-2.5">
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ background: colorOf(bucket.key) }}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-[var(--sk-ink)]">
                          {bucket.name}
                        </span>
                        <span className="shrink-0 text-sm font-medium tabular-nums text-[var(--sk-ink)]">
                          {formatInr(bucket.amount)}
                        </span>
                        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-[var(--sk-ink-3)]">
                          {formatShare(total > 0 ? (bucket.amount / total) * 100 : 0)}
                        </span>
                        <span aria-hidden className="shrink-0 text-[var(--sk-ink-3)]">
                          ›
                        </span>
                      </div>
                      <div className="mt-1.5 ml-5 h-1 overflow-hidden rounded-full bg-[var(--sk-plane)]">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${max > 0 ? (bucket.amount / max) * 100 : 0}%`,
                            background: colorOf(bucket.key),
                          }}
                        />
                      </div>
                    </button>
                  </li>
                ))}
          </ul>

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={onExpand}
              className="mt-3 w-full rounded-xl border border-[var(--sk-hair)] py-2 text-[0.8125rem] font-medium text-[var(--sk-accent-ink)] active:bg-[var(--sk-plane)]"
            >
              Show {hiddenCount} more
            </button>
          )}
        </>
      )}
    </div>
  );
}
