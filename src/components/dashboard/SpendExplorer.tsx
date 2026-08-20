"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { UNCATEGORISED, type Bucket, type PeriodBreakdown } from "@/lib/dashboard";
import type { PeriodKey } from "@/lib/periods";
import { formatInr } from "@/lib/formatInr";

// The donut ramp, darkest first. Colour here encodes MAGNITUDE, not identity:
// the biggest slice is always the darkest step, so the ring reads as an ordered
// warm gradient rather than a set of arbitrary hues. Validated as an ordinal
// ramp (single hue, monotone lightness, adjacent dL >= 0.06, lightest step
// >= 2:1 against the white card) - see globals.css.
//
// The consequence to know about: because the mapping follows rank, switching
// pills can repaint a category. That is why every slice is direct-labelled in
// the list below the chart and identity never rests on colour alone.
const RAMP = [
  "var(--sk-c7)",
  "var(--sk-c6)",
  "var(--sk-c5)",
  "var(--sk-c4)",
  "var(--sk-c3)",
  "var(--sk-c2)",
  "var(--sk-c1)",
];

// Uncategorised is deliberately outside the ramp: it is the absence of a
// category, not a small one, and a neutral grey keeps it from reading as
// "the least you spent on".
const UNCATEGORISED_COLOR = "#9a938b";

// Past this many named slices the ring stops being readable and the tail goes
// into "Other" - which is then sorted back into place by size like any other
// slice, so "darker = bigger" stays true.
const MAX_NAMED_SLICES = 6;

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

// A share that rounds to 0 but isn't 0 must not print "0%" next to a non-zero
// rupee figure - the two would contradict each other on the same line.
function formatShare(share: number): string {
  if (share > 0 && share < 0.5) return "<1%";
  return `${Math.round(share)}%`;
}

interface Slice extends Bucket {
  color: string;
  share: number;
}

export function SpendExplorer({ periods }: { periods: PeriodBreakdown[] }) {
  const [period, setPeriod] = useState<PeriodKey>("day");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const breakdown = periods.find((p) => p.key === period) ?? periods[0];

  // Every category that appears in any period, so hiding one on "Today" keeps
  // it hidden when the pill moves to "This month" and it reappears in the data.
  const allBuckets = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of periods) for (const b of p.buckets) if (!seen.has(b.key)) seen.set(b.key, b.name);
    return [...seen.entries()]
      .map(([key, name]) => ({ key, name }))
      .sort((a, b) => {
        if (a.key === UNCATEGORISED) return 1;
        if (b.key === UNCATEGORISED) return -1;
        return a.name.localeCompare(b.name);
      });
  }, [periods]);

  const { total, uncategorised, uncategorisedShare, slices } = useMemo(() => {
    const visible = breakdown.buckets.filter((b) => !hidden.has(b.key));
    const sum = visible.reduce((acc, b) => acc + b.amount, 0);
    const uncat = visible.find((b) => b.key === UNCATEGORISED)?.amount ?? 0;
    return {
      total: sum,
      uncategorised: uncat,
      uncategorisedShare: sum > 0 ? (uncat / sum) * 100 : 0,
      slices: buildSlices(visible, sum),
    };
  }, [breakdown, hidden]);

  return (
    <section className="flex flex-col gap-4">
      <PillRow
        period={period}
        onPeriod={setPeriod}
        buckets={allBuckets}
        hidden={hidden}
        onHidden={setHidden}
      />

      <div className="rounded-3xl border border-[var(--sk-hair)] bg-[var(--sk-surface)] p-5">
        <Donut slices={slices} total={total} label={breakdown.label} filtered={hidden.size > 0} />
        <UncategorisedCallout
          amount={uncategorised}
          share={uncategorisedShare}
          hasSpend={total > 0}
        />
      </div>

      <CategoryDetail slices={slices} label={breakdown.label} />
    </section>
  );
}

/**
 * Top slices by amount, tail folded into "Other", uncategorised pinned last in
 * neutral grey. The named slices are re-sorted *after* folding so the ramp's
 * darkest step always belongs to the biggest slice on screen.
 */
function buildSlices(buckets: Bucket[], total: number): Slice[] {
  const named = buckets.filter((b) => b.key !== UNCATEGORISED);
  const uncategorised = buckets.find((b) => b.key === UNCATEGORISED);

  const head = named.slice(0, MAX_NAMED_SLICES);
  const tail = named.slice(MAX_NAMED_SLICES);
  if (tail.length > 0) {
    head.push({
      key: "other",
      // Not "Other": there is a real category by that name, and two rows
      // reading "Other" in the same list would be indistinguishable.
      name: `+${tail.length} more`,
      amount: tail.reduce((sum, b) => sum + b.amount, 0),
    });
  }
  head.sort((a, b) => b.amount - a.amount);

  // Spread the used steps across the whole ramp rather than crowding the dark
  // end: with three slices this gives darkest / middle / lightest, which
  // separates far better than the three darkest browns would.
  const step = (i: number) =>
    head.length <= 1 ? RAMP[0] : RAMP[Math.round((i / (head.length - 1)) * (RAMP.length - 1))];

  const slices: Slice[] = head.map((b, i) => ({
    ...b,
    color: step(i),
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

function PillRow({
  period,
  onPeriod,
  buckets,
  hidden,
  onHidden,
}: {
  period: PeriodKey;
  onPeriod: (p: PeriodKey) => void;
  buckets: { key: string; name: string }[];
  hidden: ReadonlySet<string>;
  onHidden: (next: ReadonlySet<string>) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <FilterControl buckets={buckets} hidden={hidden} onHidden={onHidden} />
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
              onClick={() => onPeriod(pill.key)}
              className={`min-w-0 flex-1 truncate rounded-full px-2 py-2 text-[0.8125rem] font-medium transition-colors ${
                active
                  ? "bg-[var(--sk-accent)] text-white"
                  : "text-[var(--sk-ink-3)] active:bg-[var(--sk-plane)]"
              }`}
            >
              {pill.label}
            </button>
          );
        })}
      </div>
    </div>
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
            ? "border-[var(--sk-accent)] bg-[var(--sk-accent-tint)] text-[var(--sk-accent-ink)]"
            : "border-[var(--sk-hair)] bg-[var(--sk-surface)] text-[var(--sk-ink-3)]"
        }`}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden className="size-[1.125rem]">
          <path
            d="M4 6h16M7 12h10M10 18h4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {active && (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-[var(--sk-accent)] text-[0.5625rem] font-bold text-white"
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
                className="size-4 accent-[var(--sk-accent)]"
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
  label,
  filtered,
}: {
  slices: Slice[];
  total: number;
  label: string;
  filtered: boolean;
}) {
  let offset = 0;
  const arcs = slices.map((slice) => {
    const length = (slice.amount / total) * CIRCUMFERENCE;
    const arc = { slice, length, offset };
    offset += length;
    return arc;
  });

  return (
    <div className="relative mx-auto w-full max-w-[17.5rem]">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full" role="img"
        aria-label={`Spend by category, ${label}: ${formatInr(total)} total`}>
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="var(--sk-plane)"
          strokeWidth={THICKNESS}
        />
        {total > 0 &&
          arcs.map(({ slice, length, offset: start }) => (
            <circle
              key={slice.key}
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke={slice.color}
              strokeWidth={THICKNESS}
              // Never let a real slice vanish into the gap: a hairline still
              // says "this exists", where 0 would silently drop it.
              strokeDasharray={`${Math.max(length - GAP, 1)} ${CIRCUMFERENCE}`}
              strokeDashoffset={-start}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            >
              <title>{`${slice.name}: ${formatInr(slice.amount)} (${formatShare(slice.share)})`}</title>
            </circle>
          ))}
      </svg>

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-10 text-center">
        <span className="text-[1.75rem] font-semibold leading-none tracking-tight text-[var(--sk-ink)]">
          {formatInr(total)}
        </span>
        <span className="mt-1.5 text-[0.8125rem] text-[var(--sk-ink-3)]">{label}</span>
        {filtered && (
          <span className="mt-0.5 text-[0.6875rem] font-medium text-[var(--sk-accent-ink)]">
            filtered
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Uncategorised spend as a share of the period's total, styled to escalate:
 * calm and quiet when it is a rounding error, insistent when it is big enough
 * to make every other number on this screen wrong. Kept deliberately smaller
 * and lighter than the donut's centre total - it is a sub-metric, not a rival
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
        <Icon level={level} />
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
function Icon({ level }: { level: "calm" | "caution" | "alarm" }) {
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
 * The detail panel. In Pass 1 this is a static list - it also serves as the
 * chart's legend and its table view, so every slice is named and valued in
 * text and nothing depends on telling two browns apart. Pass 2 turns these
 * rows into the drill-down.
 */
function CategoryDetail({ slices, label }: { slices: Slice[]; label: string }) {
  const max = slices.reduce((m, s) => Math.max(m, s.amount), 0);

  return (
    <div className="rounded-3xl border border-[var(--sk-hair)] bg-[var(--sk-surface)] p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[0.9375rem] font-semibold text-[var(--sk-ink)]">Top categories</h2>
        <span className="text-xs text-[var(--sk-ink-3)]">{label}</span>
      </div>

      {slices.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--sk-ink-3)]">No spend in this period.</p>
      ) : (
        <ul className="mt-3 flex flex-col">
          {slices.map((slice) => (
            <li key={slice.key} className="border-b border-[var(--sk-hair)] py-2.5 last:border-b-0">
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: slice.color }}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--sk-ink)]">
                  {slice.name}
                </span>
                <span className="shrink-0 text-sm font-medium tabular-nums text-[var(--sk-ink)]">
                  {formatInr(slice.amount)}
                </span>
                <span className="w-9 shrink-0 text-right text-xs tabular-nums text-[var(--sk-ink-3)]">
                  {formatShare(slice.share)}
                </span>
              </div>
              <div className="mt-1.5 ml-5 h-1 overflow-hidden rounded-full bg-[var(--sk-plane)]">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${max > 0 ? (slice.amount / max) * 100 : 0}%`, background: slice.color }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
