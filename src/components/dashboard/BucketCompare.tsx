"use client";

import { SERIES_COMPARISON, SERIES_CURRENT } from "@/lib/categoryColors";
import { formatInr } from "@/lib/formatInr";

/**
 * One slot of the time chart, opened up: the same slot in both periods, split
 * by category as GROUPED bars - each category gets the current period's bar
 * next to the comparison period's, so "why was that Tuesday bigger?" is
 * answered by which pair diverged.
 *
 * Colour here means WHICH PERIOD, exactly as it does in the chart this view
 * zooms out to - the same teal and purple - and the category is carried by the
 * row label instead. Bars run horizontally because category names are long and
 * a phone is narrow: vertical bars would either clip "Kirana & Local Stores"
 * or turn the axis into diagonal text.
 */
export interface TowerSegment {
  key: string;
  name: string;
  current: number;
  previous: number;
}

const BAR_HEIGHT = 14;
const OTHER_KEY = "__other";

export function BucketCompare({
  segments,
  currentLabel,
  comparisonLabel,
  currentTotal,
  previousTotal,
  maxRows = 5,
}: {
  segments: TowerSegment[];
  currentLabel: string;
  comparisonLabel: string;
  currentTotal: number;
  previousTotal: number;
  /** Categories shown before the tail folds into "Other". */
  maxRows?: number;
}) {
  const rows = foldTail(segments, maxRows);
  // One scale across both series and every row, so bar lengths are comparable
  // down the whole column as well as within a pair.
  const max = rows.reduce((m, r) => Math.max(m, r.current, r.previous), 0) || 1;

  return (
    <div>
      <ul className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1">
        <LegendItem color={SERIES_CURRENT} label={currentLabel} total={currentTotal} />
        <LegendItem color={SERIES_COMPARISON} label={comparisonLabel} total={previousTotal} />
      </ul>

      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--sk-ink-3)]">
          No spend in either period.
        </p>
      ) : (
        <ul className="flex flex-col gap-3.5">
          {rows.map((row) => (
            <li key={row.key}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-[0.8125rem] font-medium text-[var(--sk-ink)]">
                  {row.name}
                </span>
                <Delta current={row.current} previous={row.previous} />
              </div>
              <Bar value={row.current} max={max} color={SERIES_CURRENT} />
              <Bar value={row.previous} max={max} color={SERIES_COMPARISON} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  // A zero bar still gets its row, marked with a dash rather than left blank -
  // "nothing this period" and "no row here" must not look the same.
  const width = value > 0 ? Math.max((value / max) * 100, 1.5) : 0;
  return (
    <div className="mt-[3px] flex items-center gap-1.5">
      <div className="h-[14px] min-w-0 flex-1">
        {width > 0 ? (
          <div
            className="h-full rounded-[3px]"
            style={{ width: `${width}%`, height: BAR_HEIGHT, background: color }}
          />
        ) : null}
      </div>
      <span className="w-[4.5rem] shrink-0 text-right text-[0.6875rem] font-semibold tabular-nums text-[var(--sk-ink-2)]">
        {value > 0 ? formatInr(value) : "—"}
      </span>
    </div>
  );
}

// The per-category change, using the dashboard's colour rule: more is red.
function Delta({ current, previous }: { current: number; previous: number }) {
  if (previous === 0 && current === 0) return null;
  if (previous === 0) {
    return <span className="shrink-0 text-[0.6875rem] font-semibold text-[var(--sk-bad)]">new</span>;
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  const tone = pct > 0 ? "text-[var(--sk-bad)]" : pct < 0 ? "text-[var(--sk-good)]" : "text-[var(--sk-warn)]";
  return (
    <span className={`shrink-0 text-[0.6875rem] font-semibold tabular-nums ${tone}`}>
      {pct > 0 ? "↑" : pct < 0 ? "↓" : "→"}
      {Math.abs(pct)}%
    </span>
  );
}

function LegendItem({ color, label, total }: { color: string; label: string; total: number }) {
  return (
    <li className="flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />
      <span className="truncate text-[0.75rem] text-[var(--sk-ink-2)]">
        {label}
        <span className="font-semibold text-[var(--sk-ink)]"> {formatInr(total)}</span>
      </span>
    </li>
  );
}

/**
 * Biggest categories by combined spend, tail folded into one "Other" row.
 * Ranking on the two periods together rather than on the current one keeps a
 * category that collapsed to zero this period visible - that disappearance is
 * usually the thing worth seeing.
 */
function foldTail(segments: TowerSegment[], maxRows: number): TowerSegment[] {
  const ranked = [...segments]
    .filter((s) => s.current > 0 || s.previous > 0)
    .sort((a, b) => b.current + b.previous - (a.current + a.previous));
  if (ranked.length <= maxRows + 1) return ranked;
  const head = ranked.slice(0, maxRows);
  const tail = ranked.slice(maxRows);
  head.push({
    key: OTHER_KEY,
    name: `Other (${tail.length})`,
    current: tail.reduce((s, r) => s + r.current, 0),
    previous: tail.reduce((s, r) => s + r.previous, 0),
  });
  return head;
}
