// Period windows for the dashboard's comparison cards, chart pills and stepper.
//
// Every boundary is anchored on the *budget day*, not on midnight: the app
// already defines "a day" as resetHour->resetHour on the IST clock (see
// budgetDayWindowUtc), and the dashboard must agree with the budget push that
// fires against the same definition. Weeks therefore start at resetHour on
// Monday, and months at resetHour on the 1st - not at 00:00.
import { budgetDayWindowUtc } from "@/lib/budget";
import { istDayMonth, istMonthYear, istWeekdayDate } from "@/lib/formatIst";

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface Window {
  startISO: string;
  endISO: string;
}

export const PERIOD_KEYS = ["day", "week", "month"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

/** How many whole periods back the user has stepped. 0 is the live period. */
export type Offsets = Record<PeriodKey, number>;

/** Never step into the future, and stop somewhere short of the epoch. */
export const MIN_OFFSET = -120;

export function clampOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(0, Math.max(MIN_OFFSET, Math.trunc(value)));
}

export interface PeriodComparison {
  key: PeriodKey;
  /** Whole periods back; 0 means the live, still-running period. */
  offset: number;
  /** Card heading and chart label, e.g. "This month" or "March 2026". */
  label: string;
  /** Short caption under the % chip - must survive a third of a phone screen. */
  comparisonLabel: string;
  /** Standalone name for the comparison period, for a chart legend. */
  comparisonName: string;
  /** The full rule, for the card's title/aria text where there is room for it. */
  comparisonDetail: string;
  current: Window;
  previous: Window;
  /** True when stepping further back is possible (it always is) / forward. */
  canStepForward: boolean;
}

function istPartsAt(utcMs: number) {
  const ist = new Date(utcMs + IST_OFFSET_MS);
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth(),
    weekday: ist.getUTCDay(), // 0 = Sunday
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

// Start of the budget day that `dayStartMs` belongs to, shifted to the Monday
// of that ISO week. Monday-start is explicit in the brief; JS weekdays are
// Sunday-start, hence the +6 %7.
function weekStartMs(dayStartMs: number): number {
  const { weekday } = istPartsAt(dayStartMs);
  return dayStartMs - ((weekday + 6) % 7) * DAY_MS;
}

// Start of the budget day beginning the calendar month `monthOffset` months
// from the one `dayStartMs` belongs to.
function monthStartMs(dayStartMs: number, resetHour: number, monthOffset = 0): number {
  const { year, month } = istPartsAt(dayStartMs);
  return Date.UTC(year, month + monthOffset, 1, resetHour, 0, 0, 0) - IST_OFFSET_MS;
}

/**
 * The three comparison windows, each at its own step offset.
 *
 * A LIVE period (offset 0) compares like elapsed portions: on a Thursday, this
 * week is Mon-now and last week is the previous Mon plus exactly the same
 * elapsed milliseconds, so a part-finished week is never flattered by being
 * measured against a complete one.
 *
 * A STEPPED period (offset < 0) is already over, so it is compared whole
 * against the whole period immediately before it - August against July, and
 * stepping back to March gives March against February. There is deliberately no
 * way to compare arbitrary pairs; the comparison always follows the selection.
 *
 * The day card deliberately does NOT truncate: "yesterday" is the whole budget
 * day, because that is the number the user recognises as what they spent
 * yesterday, and it is the same window the budget notification reports.
 */
export function periodComparisons(
  resetHour: number,
  offsets: Offsets = { day: 0, week: 0, month: 0 },
  nowMs: number = Date.now()
): PeriodComparison[] {
  const today = budgetDayWindowUtc(resetHour, nowMs);
  const todayStartMs = Date.parse(today.startISO);

  return [
    dayPeriod(todayStartMs, clampOffset(offsets.day)),
    weekPeriod(todayStartMs, clampOffset(offsets.week), nowMs),
    monthPeriod(todayStartMs, resetHour, clampOffset(offsets.month), nowMs),
  ];
}

function dayPeriod(todayStartMs: number, offset: number): PeriodComparison {
  const start = todayStartMs + offset * DAY_MS;
  const live = offset === 0;
  return {
    key: "day",
    offset,
    // A stepped day is named by its date; the live one stays "Today", which is
    // the only label that keeps meaning as the clock moves.
    label: live ? "Today" : istWeekdayDate(start),
    comparisonLabel: live ? "vs yesterday" : "vs the day before",
    comparisonName: live ? "Yesterday" : istWeekdayDate(start - DAY_MS),
    comparisonDetail: live
      ? "Today so far, against the whole of yesterday"
      : `${istWeekdayDate(start)}, against the day before it`,
    current: { startISO: iso(start), endISO: iso(start + DAY_MS) },
    // A finished day is compared whole; the live one is deliberately compared
    // against the WHOLE of yesterday, because that is the number that is
    // recognisable and the one the budget push reports.
    previous: { startISO: iso(start - DAY_MS), endISO: iso(start) },
    canStepForward: offset < 0,
  };
}

function weekPeriod(todayStartMs: number, offset: number, nowMs: number): PeriodComparison {
  const start = weekStartMs(todayStartMs) + offset * WEEK_MS;
  const prevStart = start - WEEK_MS;
  const live = offset === 0;
  const end = live ? nowMs : start + WEEK_MS;
  return {
    key: "week",
    offset,
    label: live ? "This week" : `Week of ${istDayMonth(start)}`,
    comparisonLabel: live ? "vs last week" : "vs previous",
    comparisonName: live ? "Last week" : `Week of ${istDayMonth(prevStart)}`,
    comparisonDetail: live
      ? "Monday to now, against the same days of last week"
      : `The week of ${istDayMonth(start)}, against the week before it`,
    current: { startISO: iso(start), endISO: iso(end) },
    previous: {
      startISO: iso(prevStart),
      // A live week compares like-for-like elapsed; a finished week is whole.
      endISO: iso(live ? prevStart + (nowMs - start) : start),
    },
    canStepForward: offset < 0,
  };
}

function monthPeriod(
  todayStartMs: number,
  resetHour: number,
  offset: number,
  nowMs: number
): PeriodComparison {
  const start = monthStartMs(todayStartMs, resetHour, offset);
  const prevStart = monthStartMs(todayStartMs, resetHour, offset - 1);
  const nextStart = monthStartMs(todayStartMs, resetHour, offset + 1);
  const live = offset === 0;
  const end = live ? nowMs : nextStart;
  return {
    key: "month",
    offset,
    label: live ? "This month" : istMonthYear(start),
    comparisonLabel: live ? "vs last month" : "vs previous",
    comparisonName: live ? "Last month" : istMonthYear(prevStart),
    comparisonDetail: live
      ? "The 1st to now, against the same days of last month"
      : `${istMonthYear(start)}, against ${istMonthYear(prevStart)}`,
    current: { startISO: iso(start), endISO: iso(end) },
    previous: {
      startISO: iso(prevStart),
      endISO: iso(live ? prevStart + (nowMs - start) : start),
    },
    canStepForward: offset < 0,
  };
}

/**
 * The spans the dashboard must fetch, merged so overlapping windows cost one
 * query rather than six. Stepping the month back a year puts the month windows
 * nowhere near today's, so a single min-to-max span would drag in a year of
 * rows to show two months of them.
 */
export function dashboardFetchWindows(periods: PeriodComparison[]): Window[] {
  const spans = periods
    .flatMap((p) => [p.current, p.previous])
    .map((w) => [Date.parse(w.startISO), Date.parse(w.endISO)] as const)
    .sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged.map(([start, end]) => ({ startISO: iso(start), endISO: iso(end) }));
}
