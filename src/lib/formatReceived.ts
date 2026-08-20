// "Received" time can come from two different, differently-formatted
// sources: the phone Shortcut's raw, human-readable string (e.g. "21 Jul
// 2026 at 4:30 PM" - not ISO, native Date parsing fails on it outright) or
// a real ISO 8601 timestamp (from the reconciliation script, or the
// server's own raw_messages.created_at fallback). Whatever the source, this
// is the single place that turns it into one consistent displayed format -
// storage stays raw/unparsed (we still don't know every shape the phone
// might send), but display never varies by source.
const SHORTCUT_FORMAT = /^(\d{1,2})\s+(\w{3})\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parsePhoneReceivedAt(raw: string): Date | null {
  const isoAttempt = new Date(raw);
  if (!Number.isNaN(isoAttempt.getTime())) return isoAttempt;

  const m = SHORTCUT_FORMAT.exec(raw.trim());
  if (!m) return null;
  const [, day, monStr, year, hourStr, minute, ampm] = m;
  const month = MONTHS[monStr.toLowerCase()];
  if (month === undefined) return null;
  let hour = parseInt(hourStr, 10) % 12;
  if (ampm.toUpperCase() === "PM") hour += 12;
  // The Shortcut's string has no timezone info; treated as IST (Asia/Kolkata,
  // UTC+5:30), matching where these messages are actually received.
  const utcMs = Date.UTC(parseInt(year, 10), month, parseInt(day, 10), hour, parseInt(minute, 10)) - 5.5 * 60 * 60 * 1000;
  return new Date(utcMs);
}

const DISPLAY_FORMAT: Intl.DateTimeFormatOptions = {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
};

// Neither source here is the exact transaction moment: transaction_date is
// date-only and the SMS text carries no time for standard transactions, and
// the phone's own timestamp is only as reliable as the Shortcut's clock.
// Always labeled "Received" by callers, never "Transaction time".
export function formatReceived(phoneReceivedAt: string | null, serverCreatedAt: string | null): string {
  if (phoneReceivedAt) {
    const parsed = parsePhoneReceivedAt(phoneReceivedAt);
    if (parsed) return parsed.toLocaleString("en-IN", DISPLAY_FORMAT);
  }
  if (!serverCreatedAt) return "—";
  return new Date(serverCreatedAt).toLocaleString("en-IN", DISPLAY_FORMAT);
}

// Compact variant for the /transactions Date column, which has to fit four
// columns onto a phone screen without horizontal scroll. Drops the time (the
// full timestamp is still shown in the row's expanded details) - "19 Aug" vs
// "19 Aug, 10:22 pm" is the difference between fitting and not.
const SHORT_FORMAT: Intl.DateTimeFormatOptions = {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
};
const SHORT_FORMAT_WITH_YEAR: Intl.DateTimeFormatOptions = {
  ...SHORT_FORMAT,
  year: "2-digit",
};

// The year is shown only when it isn't the current one. The list spans two
// years of data and can be sorted or filtered back into 2024, where a bare
// "22 Jul" is genuinely ambiguous - but printing the year on every row would
// cost width on the ~95% of rows where it says nothing.
function shortFormatFor(d: Date): Intl.DateTimeFormatOptions {
  const istYear = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
  });
  return istYear.format(d) === istYear.format(new Date())
    ? SHORT_FORMAT
    : SHORT_FORMAT_WITH_YEAR;
}

export function formatReceivedShort(
  phoneReceivedAt: string | null,
  serverCreatedAt: string | null
): string {
  const d = phoneReceivedAt
    ? parsePhoneReceivedAt(phoneReceivedAt)
    : serverCreatedAt
      ? new Date(serverCreatedAt)
      : null;
  if (!d || Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", shortFormatFor(d));
}
