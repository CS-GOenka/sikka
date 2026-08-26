// Which credits are worth a push.
//
// Credits fired nothing at all before this: ingest routed only debits to a
// notifier, and that notifier required type === "debit", so all 291 credits on
// record passed through silently. These cases pin both halves - what must now
// notify, and the things that must still stay quiet.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shouldNotifyCredit } from "../creditNotification.ts";

const credit = {
  type: "credit",
  status: "success",
  is_transfer: false,
  currency: "INR",
  amount: 500,
  categories: { name: "Friends" } as { name: string } | null,
};

describe("shouldNotifyCredit", () => {
  test("REGRESSION: an ordinary incoming payment notifies", () => {
    // The case that silently did nothing - e.g. "Rs 500 from Puja Agrawal".
    assert.equal(shouldNotifyCredit(credit), true);
  });

  test("an uncategorised credit still notifies", () => {
    // Money arriving matters before anyone has filed it.
    assert.equal(shouldNotifyCredit({ ...credit, categories: null }), true);
  });

  test("REGRESSION: an Investments credit notifies", () => {
    // The important divergence from the debit rule. Investments has
    // counts_as_spend = false, so reusing the debit gate would have suppressed
    // twelve real credits including a Rs 1,46,233 mutual-fund redemption.
    assert.equal(
      shouldNotifyCredit({ ...credit, amount: 146233, categories: { name: "Investments" } }),
      true
    );
  });

  test("a refund notifies", () => {
    assert.equal(shouldNotifyCredit({ ...credit, amount: 449, categories: { name: "Quick Commerce" } }), true);
  });

  test("MUST STAY QUIET: a debit", () => {
    // Debits have their own budget notification; this must not double up.
    assert.equal(shouldNotifyCredit({ ...credit, type: "debit" }), false);
  });

  test("MUST STAY QUIET: a transfer between the user's own accounts", () => {
    // Eleven such rows exist, all "from SAURABH GOENKA". Not money arriving,
    // and the credit-card bill payments among them already push separately.
    assert.equal(shouldNotifyCredit({ ...credit, amount: 50000, is_transfer: true }), false);
  });

  test("MUST STAY QUIET: the Ignore category", () => {
    // The explicit dismiss action - the only category that suppresses a credit.
    assert.equal(shouldNotifyCredit({ ...credit, categories: { name: "Ignore" } }), false);
  });

  test("MUST STAY QUIET: an unsuccessful credit", () => {
    assert.equal(shouldNotifyCredit({ ...credit, status: "failed" }), false);
    assert.equal(shouldNotifyCredit({ ...credit, status: null }), false);
  });

  test("MUST STAY QUIET: a zero or missing amount", () => {
    assert.equal(shouldNotifyCredit({ ...credit, amount: 0 }), false);
    assert.equal(shouldNotifyCredit({ ...credit, amount: null }), false);
  });

  test("MUST STAY QUIET: a non-INR credit", () => {
    // Foreign credits are converted to INR at ingest before this runs; one that
    // is still foreign here failed conversion and has no trustworthy amount.
    assert.equal(shouldNotifyCredit({ ...credit, currency: "USD" }), false);
  });

  test("an 'ignored' classification is not a credit at all", () => {
    // Credit-card "payment received" confirmations classify as ignored, and
    // they already fire their own push - 31 of them are on record.
    assert.equal(shouldNotifyCredit({ ...credit, type: "ignored" }), false);
  });
});
