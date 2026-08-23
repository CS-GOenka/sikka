// Deciding what to store in raw_messages.phone_received_at.
//
// That column is the anchor for every spend query - computeTodaySpend, the
// dashboard's period windows and /capture-check all range over it - so it
// decides which budget day a transaction lands in. Getting it wrong files real
// spend under the wrong day.
//
// Three senders write it, and they do NOT mean the same thing by it:
//
//   SMS automation   phoneReceivedAt is the moment the SMS arrived, which for a
//   (iOS Shortcut)   real-time bank alert is the moment the money moved. It is
//                    authoritative; nothing should override it.
//
//   Reconcile script phoneReceivedAt is the SMS's true arrival instant, read
//                    back from the phone. Also authoritative, even when it is
//                    days after the transaction date (a bank can genuinely
//                    notify a refund late - see the credit rows dated days
//                    before their SMS).
//
//   Share Sheet      A message the user shares by hand, usually because they
//   (iOS Shortcut)   noticed a missed transaction days later. Anything the
//                    Shortcut can put here is the moment of SHARING, not the
//                    moment of spending, so the date in the message text is the
//                    better source and must win.
//
// The Share Sheet and the SMS automation post the same body shape and the same
// IST human date format, so the server cannot tell them apart by inspecting the
// payload. Timestamp precision was checked as a signal and rejected: the
// automation's stamps are minute-precision too (:00.000), because that is a
// property of the iOS date format both Shortcuts use, not of either one. So a
// manual capture has to say that it is one.

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Values a sender may use to declare itself a hand-made capture. */
const MANUAL_SOURCES = new Set(["manual", "share", "share-sheet", "sharesheet", "share_sheet"]);

export function isManualCapture(rawSource: unknown): boolean {
  return typeof rawSource === "string" && MANUAL_SOURCES.has(rawSource.trim().toLowerCase());
}

/**
 * Midday IST on the date parsed out of the message, or null when that date is
 * today, unparseable, or in the future.
 *
 * Midday because it sits safely inside a budget day whatever the reset hour,
 * unlike midnight, which a 03:00 reset would push into the day before. Null for
 * today because a same-day capture should keep a live timestamp: it is equally
 * accurate and it is the only thing that puts the row inside /capture-check's
 * rolling 1h/6h windows, which exist to confirm a capture just landed.
 */
export function backdatedAnchor(transactionDate: string | null, nowMs: number): string | null {
  const m = transactionDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(transactionDate) : null;
  if (!m) return null;
  const istNow = new Date(nowMs + IST_OFFSET_MS);
  const sameDay =
    istNow.getUTCFullYear() === +m[1] &&
    istNow.getUTCMonth() === +m[2] - 1 &&
    istNow.getUTCDate() === +m[3];
  if (sameDay) return null;
  const istNoonMs = Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0) - IST_OFFSET_MS;
  // Never invent a future receipt time (a mis-parsed or post-dated SMS).
  if (istNoonMs > nowMs) return null;
  return new Date(istNoonMs).toISOString();
}

/**
 * Receipt time for a sender that supplied none - notably the Share Sheet before
 * it was taught to send one. Falls back to the message's own date, then to now.
 */
export function fallbackReceivedAt(transactionDate: string | null, nowMs: number = Date.now()): string {
  return backdatedAnchor(transactionDate, nowMs) ?? new Date(nowMs).toISOString();
}

/**
 * The precedence rule.
 *
 * Manual capture: the message text wins whenever it carries a usable past date,
 * because a hand-shared SMS is typically days old and the supplied timestamp is
 * when it was shared. With no usable date (today's, or unparseable) there is
 * nothing better, so the supplied time stands.
 *
 * Everything else: unchanged. phoneReceivedAt is the transaction time on the
 * automatic path and the true arrival instant from the reconcile script, so it
 * is never second-guessed - including when it legitimately falls days after the
 * date printed in the message.
 */
export function resolveReceivedAt(
  phoneReceivedAt: string | null,
  transactionDate: string | null,
  manualCapture: boolean,
  nowMs: number = Date.now()
): string {
  if (manualCapture) {
    const anchor = backdatedAnchor(transactionDate, nowMs);
    if (anchor) return anchor;
  }
  return phoneReceivedAt ?? fallbackReceivedAt(transactionDate, nowMs);
}
