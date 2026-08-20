"use client";

import { useMemo } from "react";
import type { Granularity, TimeBucket } from "@/lib/dashboard";
import { formatInr } from "@/lib/formatInr";
import { istDay, istDayNumber, istHour, istHourRange } from "@/lib/formatIst";

// One hue, one axis, thin marks, recessive chrome. The bars answer "when",
// where the donut answers "on what" - the same scope, a different question.
const TRACK_HEIGHT = 132;
const MIN_BAR_PX = 2; // a spent hour must never be indistinguishable from an empty one

export function TimeBars({
  buckets,
  granularity,
  selected,
  onSelect,
}: {
  buckets: TimeBucket[];
  granularity: Granularity;
  selected: number | null;
  onSelect: (index: number | null) => void;
}) {
  const max = useMemo(() => buckets.reduce((m, b) => Math.max(m, b.amount), 0), [buckets]);

  // Direct-label the peak only. A number on every bar is unreadable at phone
  // width and adds nothing the readout above the chart doesn't already give on
  // tap - but the peak is the one value worth reading without any interaction.
  const peak = useMemo(() => {
    if (max <= 0) return -1;
    return buckets.findIndex((b) => b.amount === max);
  }, [buckets, max]);

  const ticks = useMemo(() => tickIndices(buckets, granularity), [buckets, granularity]);

  if (max <= 0) {
    return (
      <div
        style={{ height: TRACK_HEIGHT }}
        className="flex items-center justify-center text-sm text-[var(--sk-ink-3)]"
      >
        No spend in this period.
      </div>
    );
  }

  return (
    <div>
      {/* overflow-visible so a peak label wider than its 12px column can spill
          over its quiet neighbours instead of becoming an ellipsis. */}
      <div className="flex items-end gap-px overflow-visible" style={{ height: TRACK_HEIGHT }}>
        {buckets.map((bucket, i) => {
          const isSelected = selected === i;
          const height = bucket.amount > 0 ? Math.max((bucket.amount / max) * TRACK_HEIGHT, MIN_BAR_PX) : 0;
          return (
            <button
              key={bucket.startMs}
              type="button"
              // The hit target is the whole column, not the bar: at a month's
              // granularity a quiet day is a 2px mark that no thumb could hit.
              onClick={() => onSelect(isSelected ? null : i)}
              aria-label={`${labelFor(bucket.startMs, granularity)}: ${formatInr(bucket.amount)}`}
              aria-pressed={isSelected}
              className="group flex h-full min-w-0 flex-1 flex-col justify-end"
            >
              {i === peak && (
                <span className="mb-1 whitespace-nowrap text-center text-[0.625rem] font-semibold tabular-nums text-[var(--sk-ink-2)]">
                  {formatInr(bucket.amount)}
                </span>
              )}
              <span
                style={{ height }}
                className={`w-full rounded-t-[3px] transition-colors ${
                  isSelected
                    ? "bg-[var(--sk-accent-ink)]"
                    : selected === null
                      ? "bg-[var(--sk-accent)]"
                      : // Once something is selected the rest recede, so the
                        // comparison the user asked for is the thing on screen.
                        "bg-[var(--sk-c1)]"
                }`}
              />
            </button>
          );
        })}
      </div>

      <div className="mt-1.5 h-px bg-[var(--sk-hair-strong)]" />

      <div className="mt-1 flex gap-px">
        {buckets.map((bucket, i) => (
          <span
            key={bucket.startMs}
            className="min-w-0 flex-1 whitespace-nowrap text-center text-[0.625rem] tabular-nums text-[var(--sk-ink-3)]"
          >
            {ticks.has(i) ? tickLabel(bucket.startMs, granularity) : " "}
          </span>
        ))}
      </div>
    </div>
  );
}

export function bucketReadout(bucket: TimeBucket, granularity: Granularity): string {
  return labelFor(bucket.startMs, granularity);
}

function labelFor(ms: number, granularity: Granularity): string {
  return granularity === "hour" ? istHourRange(ms) : istDay(ms);
}

function tickLabel(ms: number, granularity: Granularity): string {
  return granularity === "hour" ? istHour(ms) : istDayNumber(ms);
}

// Roughly six ticks whatever the bucket count, always including the last one -
// the reader's anchor is "where does this end", and an axis that stops at 25
// when the last bar is the 31st is worse than no axis.
function tickIndices(buckets: TimeBucket[], granularity: Granularity): Set<number> {
  const target = granularity === "hour" ? 4 : 6;
  const stride = Math.max(1, Math.ceil(buckets.length / target));
  const indices = new Set<number>();
  for (let i = 0; i < buckets.length; i += stride) indices.add(i);
  const last = buckets.length - 1;
  // Drop a tick that would collide with the pinned last one.
  if (last > 0 && indices.has(last - 1)) indices.delete(last - 1);
  indices.add(last);
  return indices;
}
