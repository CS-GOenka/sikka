"use client";

import { useMemo } from "react";
import type { Granularity, TimeBucket } from "@/lib/dashboard";
import { formatInr, formatInrCompact } from "@/lib/formatInr";
import { istAxisDay, istDay, istHour, istHourRange, istWeekday } from "@/lib/formatIst";

// The bars answer "when", where the donut answers "on what" - the same scope, a
// different question.
//
// The two series are two genuinely different colours, not two shades of one:
// the current period wears the scope's own category hue, and the comparison is
// always the same warm neutral. Neutral on purpose - it carries no chroma, so
// it can never be mistaken for a category, and "grey is the past" stays true
// whatever the user has drilled into.
const TRACK_HEIGHT = 148;
// The per-bar value labels sit above the track, so the column has to be taller
// than the track by exactly that much. Without the extra room a full-height bar
// pushes its own label out of the box, and the topmost y-tick lands in the
// legend.
const LABEL_ROW = 16;
const CHART_HEIGHT = TRACK_HEIGHT + LABEL_ROW;
const MIN_BAR_PX = 3; // a spent hour must never be indistinguishable from an empty one
// A fixed slot width rather than a share of the container: at a month's 21
// slots, dividing the width up gives 15px per slot and every label collides.
// Fixed slots keep the bars airy and let the chart scroll instead.
//
// Wide enough for BOTH bars to carry their own value: two labels of the
// "₹29.7k" shape need roughly 34px each, and a label that does not fit over its
// own bar cannot be read as belonging to it.
const SLOT_WIDTH = 78;
const Y_TICKS = 4;

/**
 * How the x-axis names a slot. The period decides this, not the bucket size:
 * a week and a month are both bucketed by day, but a week reads as weekdays
 * and a month as dates.
 */
export type AxisMode = "hour" | "weekday" | "dayOfMonth";

export function TimeBars({
  buckets,
  granularity,
  axisMode,
  axisTitle,
  currentColor,
  comparisonColor,
  currentLabel,
  comparisonLabel,
  selected,
  onSelect,
  onZoom,
}: {
  buckets: TimeBucket[];
  granularity: Granularity;
  axisMode: AxisMode;
  axisTitle: string;
  currentColor: string;
  comparisonColor: string;
  currentLabel: string;
  comparisonLabel: string;
  selected: number | null;
  onSelect: (index: number | null) => void;
  onZoom: (index: number) => void;
}) {
  // One scale for both series. Two y-scales would make the comparison bar a
  // lie - the whole point is that the two heights are directly comparable.
  const rawMax = useMemo(
    () => buckets.reduce((m, b) => Math.max(m, b.amount, b.prevAmount), 0),
    [buckets]
  );
  const { max, ticks } = useMemo(() => niceScale(rawMax), [rawMax]);
  const xTicks = useMemo(() => tickIndices(buckets, axisMode), [buckets, axisMode]);

  if (rawMax <= 0) {
    return (
      <div
        style={{ height: TRACK_HEIGHT }}
        className="flex items-center justify-center text-sm text-[var(--sk-ink-3)]"
      >
        No spend in this period.
      </div>
    );
  }

  const height = (value: number) =>
    value > 0 ? Math.max((value / max) * TRACK_HEIGHT, MIN_BAR_PX) : 0;

  return (
    <div>
      <Legend
        currentColor={currentColor}
        comparisonColor={comparisonColor}
        currentLabel={currentLabel}
        comparisonLabel={comparisonLabel}
      />

      <div className="flex">
        {/* The y-axis is outside the scroller so the scale stays put while the
            bars move under it. */}
        <div className="relative w-11 shrink-0 pr-1.5" style={{ height: CHART_HEIGHT }} aria-hidden>
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-1.5 -translate-y-1/2 text-[0.625rem] tabular-nums text-[var(--sk-ink-3)]"
              style={{ bottom: `${(tick / max) * TRACK_HEIGHT}px` }}
            >
              {tick === 0 ? "0" : formatInrCompact(tick)}
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain">
          <div className="relative" style={{ minWidth: buckets.length * SLOT_WIDTH }}>
            {/* Gridlines sit behind the bars and stop at the axis, so they
                guide the eye without competing with the marks. */}
            <div className="absolute inset-x-0" style={{ height: CHART_HEIGHT }} aria-hidden>
              {ticks.map((tick) => (
                <div
                  key={tick}
                  className="absolute inset-x-0 h-px bg-[var(--sk-hair)]"
                  style={{ bottom: `${(tick / max) * TRACK_HEIGHT}px` }}
                />
              ))}
            </div>

            <div className="relative flex items-end" style={{ height: CHART_HEIGHT }}>
              {buckets.map((bucket, i) => {
                const isSelected = selected === i;
                return (
                  <button
                    key={bucket.startMs}
                    type="button"
                    // The hit target is the whole slot, not the bar: a quiet day
                    // is a 3px mark that no thumb could hit.
                    // Same two-stage rule as a pie segment: the first tap
                    // selects the slot, a second tap on it opens the slot up.
                    onClick={() => (isSelected ? onZoom(i) : onSelect(i))}
                    aria-label={`${labelFor(bucket.startMs, granularity)}: ${formatInr(bucket.amount)}, ${comparisonLabel} ${formatInr(bucket.prevAmount)}${isSelected ? " - tap again to open" : ""}`}
                    aria-pressed={isSelected}
                    className="flex h-full shrink-0 flex-col justify-end px-[7px]"
                    style={{ width: SLOT_WIDTH, opacity: selected !== null && !isSelected ? 0.45 : 1 }}
                  >
                    {/* Each bar carries its own value, directly above itself -
                        position is what ties a label to its series, so both stay
                        in text ink rather than taking the series colour. The
                        comparison reads one step back to keep the selected
                        period dominant. */}
                    <span className="flex w-full items-end justify-center gap-[3px]">
                      <BarColumn
                        value={bucket.amount}
                        height={height(bucket.amount)}
                        color={currentColor}
                        labelClass="text-[var(--sk-ink-2)] font-semibold"
                      />
                      <BarColumn
                        value={bucket.prevAmount}
                        height={height(bucket.prevAmount)}
                        color={comparisonColor}
                        labelClass="text-[var(--sk-ink-3)]"
                      />
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="h-px bg-[var(--sk-hair-strong)]" />

            <div className="mt-1.5 flex">
              {buckets.map((bucket, i) => (
                <span
                  key={bucket.startMs}
                  className="shrink-0 whitespace-nowrap text-center text-[0.625rem] tabular-nums text-[var(--sk-ink-3)]"
                  style={{ width: SLOT_WIDTH }}
                >
                  {xTicks.has(i) ? tickLabel(bucket.startMs, axisMode) : " "}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <p className="mt-2 text-center text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--sk-ink-3)]">
        {axisTitle}
      </p>
    </div>
  );
}

function BarColumn({
  value,
  height,
  color,
  labelClass,
}: {
  value: number;
  height: number;
  color: string;
  labelClass: string;
}) {
  return (
    <span className="flex h-full min-w-0 flex-1 flex-col justify-end">
      <span
        className={`mb-0.5 block whitespace-nowrap text-center text-[0.5625rem] tabular-nums ${labelClass}`}
        style={{ height: LABEL_ROW }}
      >
        {value > 0 ? formatInrCompact(value) : ""}
      </span>
      <span className="w-full rounded-t-[3px]" style={{ height, background: color }} />
    </span>
  );
}

// Two series means a legend is not optional: the solid/neutral distinction is a
// colour difference, and a colour difference on its own is not a label.
function Legend({
  currentColor,
  comparisonColor,
  currentLabel,
  comparisonLabel,
}: {
  currentColor: string;
  comparisonColor: string;
  currentLabel: string;
  comparisonLabel: string;
}) {
  return (
    <ul className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
      <LegendItem color={currentColor} label={currentLabel} note="selected" />
      <LegendItem color={comparisonColor} label={comparisonLabel} note="comparison" />
    </ul>
  );
}

function LegendItem({ color, label, note }: { color: string; label: string; note: string }) {
  return (
    <li className="flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />
      {/* Text ink, never the series colour - the swatch beside it carries identity. */}
      <span className="truncate text-[0.75rem] text-[var(--sk-ink-2)]">
        {label}
        <span className="text-[var(--sk-ink-3)]"> · {note}</span>
      </span>
    </li>
  );
}

export function bucketReadout(bucket: TimeBucket, granularity: Granularity): string {
  return labelFor(bucket.startMs, granularity);
}

function labelFor(ms: number, granularity: Granularity): string {
  return granularity === "hour" ? istHourRange(ms) : istDay(ms);
}

function tickLabel(ms: number, mode: AxisMode): string {
  if (mode === "hour") return istHour(ms);
  if (mode === "weekday") return istWeekday(ms);
  return istAxisDay(ms);
}

/**
 * A rounded scale ending on a round number, so the y-axis reads 0 / 10k / 20k /
 * 30k rather than 0 / 9,916 / 19,832. Returns the scale's top and its ticks.
 */
function niceScale(rawMax: number): { max: number; ticks: number[] } {
  if (rawMax <= 0) return { max: 1, ticks: [0] };
  const rough = rawMax / Y_TICKS;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? magnitude * 10;
  const max = Math.ceil(rawMax / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);
  return { max, ticks };
}

// Every date on a scrolling axis would be a wall of text; roughly every other
// slot reads as a rhythm. The last slot is always pinned - the reader's anchor
// is "where does this end", and an axis that stops at 19-Aug when the last bar
// is 21-Aug is worse than no axis.
function tickIndices(buckets: TimeBucket[], mode: AxisMode): Set<number> {
  // A week is seven slots and every weekday earns a label; hours and month
  // dates are too many to name individually at phone width.
  const stride = mode === "weekday" ? 1 : mode === "hour" ? 3 : buckets.length > 10 ? 2 : 1;
  const indices = new Set<number>();
  for (let i = 0; i < buckets.length; i += stride) indices.add(i);
  const last = buckets.length - 1;
  if (stride > 1 && last > 0 && indices.has(last - 1)) indices.delete(last - 1);
  indices.add(last);
  return indices;
}
