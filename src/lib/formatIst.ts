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
