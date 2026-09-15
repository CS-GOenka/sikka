// Display formatting for the dashboard's time axis.
//
// The account holder and all transaction data are in IST, and every boundary
// on this screen (budget days, weeks, months) is an IST boundary - so the
// labels are pinned to Asia/Kolkata rather than to the browser's zone. A phone
// carried abroad would otherwise label a bar with a different day than the bar
// actually covers.
const IST = "Asia/Kolkata";

function fmt(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-IN", { timeZone: IST, ...options });
}

const DAY_LONG = fmt({ weekday: "short", day: "numeric", month: "short" });
const DAY_NUMBER = fmt({ day: "numeric" });
const DATE_TIME = fmt({ day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" });
const HOUR = fmt({ hour: "numeric" });
const DAY_MONTH = fmt({ day: "numeric", month: "short" });
const MONTH_YEAR = fmt({ month: "long", year: "numeric" });
const WEEKDAY = fmt({ weekday: "short" });
const AXIS_DAY = fmt({ day: "2-digit", month: "short" });
const WEEKDAY_DATE = fmt({ weekday: "short", day: "numeric", month: "short" });

/** "Thu 20 Aug" - the readout above a daily bar. */
export function istDay(ms: number): string {
  return DAY_LONG.format(ms);
}

/** "20" - a tick under a daily bar, where the month is already established. */
export function istDayNumber(ms: number): string {
  return DAY_NUMBER.format(ms);
}

/** "20 Aug, 10:22 pm" - a transaction's receipt time in the drill-down list. */
export function istDateTime(ms: number): string {
  return DATE_TIME.format(ms);
}

/** "10 pm" - a tick under an hourly bar. */
export function istHour(ms: number): string {
  return HOUR.format(ms);
}

/** "10-11 pm" - the readout above an hourly bar, which covers a whole hour. */
export function istHourRange(ms: number): string {
  return `${HOUR.format(ms)}-${HOUR.format(ms + 60 * 60 * 1000)}`;
}

/** "18 Aug" - the stepper's label for a week. */
export function istDayMonth(ms: number): string {
  return DAY_MONTH.format(ms);
}

/** "August 2026" - the stepper's label for a month. */
export function istMonthYear(ms: number): string {
  return MONTH_YEAR.format(ms);
}


/** "Mon" - a tick under a bar when the period is a week. */
export function istWeekday(ms: number): string {
  return WEEKDAY.format(ms);
}

/**
 * "19-Aug" - a tick under a bar when the period is a month. Hyphenated and
 * always two digits so the ticks are one column of dates rather than prose.
 */
export function istAxisDay(ms: number): string {
  return AXIS_DAY.format(ms).replace(/\s+/, "-");
}

/** "Tue 25 Aug" - the day stepper's label for a past day. */
export function istWeekdayDate(ms: number): string {
  return WEEKDAY_DATE.format(ms);
}

// IST has no daylight saving, so a calendar day is a fixed 5h30m shift from
// UTC and "which IST day is this instant on" is a division rather than a
// formatter round-trip.
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function istDayIndex(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS);
}

/**
 * Whole IST calendar days between an instant and now.
 *
 * Counted in calendar days rather than elapsed hours, because that is what a
 * reader means by "two days ago": something from late last night is a day old
 * this morning, not zero days old for another fourteen hours. Returns null for
 * a missing or unparseable timestamp so callers can say nothing rather than
 * say "0 days".
 */
export function istAgeInDays(iso: string | null, nowMs: number = Date.now()): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, istDayIndex(nowMs) - istDayIndex(then));
}

/** "today", "1 day", "12 days" - the age half of a "13 Sept · 12 days" label. */
export function formatAge(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return "today";
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * "13 Sept · 12 days" - a dated thing and how long it has been sitting there.
 * Null when there is no usable timestamp, so the caller renders nothing at all
 * rather than an em dash standing in for a date.
 */
export function istDateWithAge(iso: string | null, nowMs: number = Date.now()): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const age = formatAge(istAgeInDays(iso, nowMs));
  return age ? `${istDayMonth(ms)} · ${age}` : istDayMonth(ms);
}
