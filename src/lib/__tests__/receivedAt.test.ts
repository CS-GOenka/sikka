// Which instant a captured transaction is filed under.
//
// This has now been the source of two separate bugs, both of which put real
// spend on the wrong budget day while the transaction itself looked correct.
// Every case below is one of them, or one of the cases that a plausible-looking
// fix would have broken.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { backdatedAnchor, fallbackReceivedAt, isManualCapture, resolveReceivedAt } from "../receivedAt.ts";

const IST_OFFSET_MS = 330 * 60 * 1000;

/** The IST calendar date a stored instant falls on - what "which day" means here. */
function istDate(iso: string): string {
  return new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 23 Aug 2026, 15:32 IST - the real moment the three mis-dated rows were shared. */
const NOW = Date.parse("2026-08-23T10:02:00.000Z");
/** What the Share Sheet sent as phoneReceivedAt at that moment. */
const SHARE_STAMP = "2026-08-23T10:02:00.000Z";

describe("isManualCapture", () => {
  test("accepts the documented markers, case and separator insensitive", () => {
    for (const value of ["manual", "share", "share-sheet", "sharesheet", "share_sheet", "MANUAL", " Share-Sheet "]) {
      assert.equal(isManualCapture(value), true, `expected ${JSON.stringify(value)} to be manual`);
    }
  });

  test("treats everything else as automatic", () => {
    // The automatic path must never be mistaken for a manual one: that would
    // move every real-time capture to midday instead of its true arrival time.
    for (const value of [undefined, null, "", "auto", "sms", "automation", "reconcile", 1, {}]) {
      assert.equal(isManualCapture(value), false, `expected ${JSON.stringify(value)} to be automatic`);
    }
  });
});

describe("backdatedAnchor", () => {
  test("anchors a past date to midday IST, not midnight", () => {
    // Midnight would fall on the wrong side of a 03:00 budget-day reset and
    // file the spend a day early.
    const anchor = backdatedAnchor("2026-08-22", NOW);
    assert.equal(anchor, "2026-08-22T06:30:00.000Z");
    assert.equal(istDate(anchor!), "2026-08-22");
  });

  test("returns null for today, so a same-day capture keeps a live time", () => {
    // A live timestamp is equally accurate and is the only thing that puts the
    // row inside /capture-check's rolling 1h/6h windows.
    assert.equal(backdatedAnchor("2026-08-23", NOW), null);
  });

  test("returns null for an unparseable or missing date", () => {
    assert.equal(backdatedAnchor(null, NOW), null);
    assert.equal(backdatedAnchor("22-Aug-26", NOW), null);
    assert.equal(backdatedAnchor("not a date", NOW), null);
  });

  test("never invents a future receipt time", () => {
    // A mis-parsed or post-dated SMS must not be filed ahead of now.
    assert.equal(backdatedAnchor("2026-09-01", NOW), null);
  });
});

describe("fallbackReceivedAt - sender supplied nothing", () => {
  test("uses the message's own date when it is in the past", () => {
    assert.equal(istDate(fallbackReceivedAt("2026-08-22", NOW)), "2026-08-22");
  });

  test("uses now when the message is dated today", () => {
    assert.equal(fallbackReceivedAt("2026-08-23", NOW), new Date(NOW).toISOString());
  });

  test("uses now when there is no date to go on", () => {
    assert.equal(fallbackReceivedAt(null, NOW), new Date(NOW).toISOString());
  });
});

describe("resolveReceivedAt - manual capture", () => {
  test("REGRESSION: a backdated share is dated by the message, not the share time", () => {
    // The reported bug. Three transactions whose text read 22-Aug-26 were filed
    // under 23-Aug because the Shortcut's Current Date won.
    const got = resolveReceivedAt(SHARE_STAMP, "2026-08-22", true, NOW);
    assert.equal(istDate(got), "2026-08-22");
  });

  test("a same-day share keeps the supplied live timestamp", () => {
    const got = resolveReceivedAt(SHARE_STAMP, "2026-08-23", true, NOW);
    assert.equal(got, SHARE_STAMP);
  });

  test("with no parseable date, the supplied timestamp stands", () => {
    const got = resolveReceivedAt(SHARE_STAMP, null, true, NOW);
    assert.equal(got, SHARE_STAMP);
  });

  test("with no timestamp supplied at all, the message date still wins", () => {
    // The Share Sheet's behaviour before it was taught to send a date.
    const got = resolveReceivedAt(null, "2026-08-22", true, NOW);
    assert.equal(istDate(got), "2026-08-22");
  });
});

describe("resolveReceivedAt - automatic capture", () => {
  test("phoneReceivedAt always wins: it is when the SMS arrived", () => {
    const got = resolveReceivedAt(SHARE_STAMP, "2026-08-23", false, NOW);
    assert.equal(got, SHARE_STAMP);
  });

  test("REGRESSION: a legitimately late refund keeps its true receipt time", () => {
    // A bank can notify a refund days after the date it quotes. Fourteen such
    // rows exist. The naive rule - "message older than receipt means misdated" -
    // would rewrite every one of them to a date they never arrived on.
    const got = resolveReceivedAt(SHARE_STAMP, "2026-08-20", false, NOW);
    assert.equal(got, SHARE_STAMP, "a late bank notification must keep its arrival time");
    assert.equal(istDate(got), "2026-08-23");
  });

  test("the reconcile script's true past receipt instant is preserved exactly", () => {
    const trueReceipt = "2026-08-20T16:44:24.166Z";
    const got = resolveReceivedAt(trueReceipt, "2026-08-20", false, NOW);
    assert.equal(got, trueReceipt);
  });

  test("falls back to the message date when no timestamp is supplied", () => {
    assert.equal(istDate(resolveReceivedAt(null, "2026-08-21", false, NOW)), "2026-08-21");
  });
});

describe("the two paths disagree only where they should", () => {
  test("same input, different source, different day - that IS the fix", () => {
    const manual = resolveReceivedAt(SHARE_STAMP, "2026-08-22", true, NOW);
    const automatic = resolveReceivedAt(SHARE_STAMP, "2026-08-22", false, NOW);
    assert.equal(istDate(manual), "2026-08-22");
    assert.equal(istDate(automatic), "2026-08-23");
    assert.notEqual(manual, automatic);
  });

  test("for a same-day message the two paths agree", () => {
    const manual = resolveReceivedAt(SHARE_STAMP, "2026-08-23", true, NOW);
    const automatic = resolveReceivedAt(SHARE_STAMP, "2026-08-23", false, NOW);
    assert.equal(manual, automatic);
  });
});
