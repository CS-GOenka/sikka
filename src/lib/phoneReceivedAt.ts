// phoneReceivedAt arrives from two senders in two different shapes:
//   1. The reconcile script (apple_ns_to_iso): a UTC ISO-8601 instant, e.g.
//      "2026-07-25T18:50:11.742547Z".
//   2. The iOS Shortcut: a device-locale IST human string, e.g.
//      "26 Jul 2026 at 12:37 AM" (12-hour with AM/PM, no timezone).
//
// This normalizes either into one canonical UTC ISO-8601 string
// (millisecond precision, "…Z"), so the stored phone_received_at column is
// consistent and directly comparable/sortable as text. Returns null for an
// unrecognized value rather than storing garbage.

const IST_OFFSET_MS = 330 * 60 * 1000; // Shortcut times are device-local IST (UTC+5:30, no DST)

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// "26 Jul 2026 at 12:37 AM"
const SHORTCUT_RE = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i;

export function normalizePhoneReceivedAt(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  // 1. Already an ISO-8601 instant (reconcile output, or anything with a
  //    date+time head that Date can parse). Re-emit canonically.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }

  // 2. iOS Shortcut IST human format.
  const m = SHORTCUT_RE.exec(s);
  if (m) {
    const day = parseInt(m[1], 10);
    const mon = MONTHS[m[2].toLowerCase()];
    const year = parseInt(m[3], 10);
    let hour = parseInt(m[4], 10);
    const min = parseInt(m[5], 10);
    const meridiem = m[6].toUpperCase();
    if (mon === undefined || hour < 1 || hour > 12 || min > 59) return null;
    if (meridiem === "PM" && hour !== 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    // Treat the parsed wall-clock as IST, convert to the real UTC instant.
    const istWallMs = Date.UTC(year, mon, day, hour, min, 0, 0);
    return new Date(istWallMs - IST_OFFSET_MS).toISOString();
  }

  return null;
}
