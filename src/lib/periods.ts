// Period windows for the dashboard's comparison cards and chart pills.
//
// Every boundary is anchored on the *budget day*, not on midnight: the app
// already defines "a day" as resetHour->resetHour on the IST clock (see
// budgetDayWindowUtc), and the dashboard must agree with the budget push that
// fires against the same definition. Weeks therefore start at resetHour on
// Monday, and months at resetHour on the 1st - not at 00:00.
import { budgetDayWindowUtc } from "@/lib/budget";

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Window {
  startISO: string;
  endISO: string;
}

export const PERIOD_KEYS = ["day", "week", "month"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

export interface PeriodComparison {
  key: PeriodKey;
  /** Card heading, e.g. "This week". */
  label: string;
  /** Short caption under the % chip - must survive a third of a phone screen. */
  comparisonLabel: string;
  /** The full rule, for the card's title/aria text where there is room for it. */
  comparisonDetail: string;
  current: Window;
  previous: Window;
}

function istPartsAt(utcMs: number) {
  const ist = new Date(utcMs + IST_OFFSET_MS);
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth(),
    date: ist.getUTCDate(),
    weekday: ist.getUTCDay(), // 0 = Sunday
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// Start of the budget day that `dayStartMs` belongs to, shifted to the Monday
// of that ISO week. Monday-start is explicit in the brief; JS weekdays are
// Sunday-start, hence the +6 %7.
function weekStartMs(dayStartMs: number): number {
  const { weekday } = istPartsAt(dayStartMs);
  return dayStartMs - ((weekday + 6) % 7) * DAY_MS;
}

// Start of the budget day beginning the calendar month that `dayStartMs`
// belongs to. `monthOffset` of -1 gives the previous month.
function monthStartMs(dayStartMs: number, resetHour: number, monthOffset = 0): number {
  const { year, month } = istPartsAt(dayStartMs);
  return Date.UTC(year, month + monthOffset, 1, resetHour, 0, 0, 0) - IST_OFFSET_MS;
}

/**
 * The three comparison windows.
 *
 * Week and month compare *like elapsed portions*: on a Thursday, this week is
 * Mon-now and last week is the previous Mon plus exactly the same elapsed
 * milliseconds, so a partly-finished week is never flattered by being measured
 * against a complete one.
 *
 * The day card deliberately does NOT truncate: "yesterday" is the whole budget
 * day, because that is the number the user recognises as what they spent
 * yesterday, and it is the same window the budget notification reports. The
 * cost is that early in a budget day the day card reads optimistically - swap
 * `previous` to `{ start: prevStart, end: prevStart + elapsed }` to make the
 * day match the week/month rule instead.
 */
export function periodComparisons(resetHour: number, nowMs: number = Date.now()): PeriodComparison[] {
  const today = budgetDayWindowUtc(resetHour, nowMs);
  const todayStartMs = Date.parse(today.startISO);

  const wStart = weekStartMs(todayStartMs);
  const weekElapsed = nowMs - wStart;
  const prevWeekStart = wStart - 7 * DAY_MS;

  const mStart = monthStartMs(todayStartMs, resetHour);
  const monthElapsed = nowMs - mStart;
  const prevMonthStart = monthStartMs(todayStartMs, resetHour, -1);

  return [
    {
      key: "day",
      label: "Today",
      comparisonLabel: "vs yesterday",
      comparisonDetail: "Today so far, against the whole of yesterday",
      current: today,
      previous: { startISO: iso(todayStartMs - DAY_MS), endISO: today.startISO },
    },
    {
      key: "week",
      label: "This week",
      comparisonLabel: "vs last week",
      comparisonDetail: "Monday to now, against the same days of last week",
      current: { startISO: iso(wStart), endISO: iso(nowMs) },
      previous: { startISO: iso(prevWeekStart), endISO: iso(prevWeekStart + weekElapsed) },
    },
    {
      key: "month",
      label: "This month",
      comparisonLabel: "vs last month",
      comparisonDetail: "The 1st to now, against the same days of last month",
      current: { startISO: iso(mStart), endISO: iso(nowMs) },
      previous: { startISO: iso(prevMonthStart), endISO: iso(prevMonthStart + monthElapsed) },
    },
  ];
}

/**
 * One window wide enough to contain every window `periodComparisons` produces,
 * so the whole dashboard can be built from a single query rather than six.
 * Starts at the previous month's start (the earliest boundary in play) and ends
 * at the end of the current budget day (the latest - today's card window runs to
 * the reset hour, which is still in the future).
 */
export function dashboardFetchWindow(periods: PeriodComparison[]): Window {
  let start = Infinity;
  let end = -Infinity;
  for (const p of periods) {
    for (const w of [p.current, p.previous]) {
      start = Math.min(start, Date.parse(w.startISO));
      end = Math.max(end, Date.parse(w.endISO));
    }
  }
  return { startISO: iso(start), endISO: iso(end) };
}
