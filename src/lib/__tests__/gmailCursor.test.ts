// When the Gmail history cursor is unusable.
//
// The poller only saves its cursor after a successful run, so a cursor it
// cannot recover from is permanent: every run for the rest of time fails on the
// same stored value. That makes "did we recognise this as a cursor problem"
// the single most consequential branch in the poller, and it is decided by
// matching Google's error text - which spells the field three different ways.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Mirror of CURSOR_COMPLAINT in src/lib/gmail/client.ts. Kept here as a literal
// rather than exported, so a change to the real one has to be made deliberately
// in both places rather than silently loosening what counts as a cursor fault.
const CURSOR_COMPLAINT = /history[_\s-]?id/i;

describe("recognising an unusable Gmail history cursor", () => {
  test("matches the proto validator's snake_case spelling", () => {
    // REGRESSION: the first version matched only camelCase, so a corrupted
    // cursor threw a generic error and the poller never fell back.
    assert.ok(CURSOR_COMPLAINT.test(`Invalid value at 'start_history_id' (TYPE_UINT64), "not-a-history-id"`));
  });

  test("matches the camelCase spellings Google uses in prose", () => {
    assert.ok(CURSOR_COMPLAINT.test("Invalid startHistoryId"));
    assert.ok(CURSOR_COMPLAINT.test("historyId is too old"));
  });

  test("does not claim unrelated 400s are cursor faults", () => {
    // A fallback triggered by the wrong error would quietly turn a real API
    // problem into a seven-day rescan on every run.
    assert.ok(!CURSOR_COMPLAINT.test("Invalid value at 'max_results' (TYPE_INT32)"));
    assert.ok(!CURSOR_COMPLAINT.test("Insufficient Permission"));
  });
});
