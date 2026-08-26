// Foreign-currency conversion.
//
// The risk here is quiet arithmetic error: a wrong markup or a rounding slip
// produces a plausible-looking rupee figure that silently distorts every total
// it lands in. Each case below pins one part of the formula, or one class of
// transaction that must NOT be converted at all.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  FX_MARKUP_RATE,
  GST_ON_MARKUP_RATE,
  convertToInr,
  describeBreakdown,
} from "../fx/convert.ts";
import { isConvertibleForeignCard } from "../fx/eligibility.ts";

describe("convertToInr", () => {
  test("ICICI's charge structure: base, then markup, then GST on the markup only", () => {
    // GST is charged on the markup, NOT on the converted amount. Charging it on
    // the base would overstate this by about 18% of the whole transaction.
    const b = convertToInr(100, "USD", 90);
    assert.equal(b.baseInr, 9000);
    assert.equal(b.markupInr, 315);            // 9000 x 3.5%
    assert.equal(b.gstInr, 56.7);              // 315 x 18%, not 9000 x 18%
    assert.equal(b.totalInr, 9371.7);
  });

  test("the parts sum exactly to the total", () => {
    // Reconciling against a statement means comparing these numbers to real
    // ones; a total that does not equal its own parts cannot be reasoned about.
    for (const [amt, rate] of [[23.6, 95.76], [324.5, 84.15], [7.07, 87.38], [415.04, 91.2], [0.01, 88.123]]) {
      const b = convertToInr(amt, "USD", rate);
      assert.equal(b.totalInr, Math.round((b.baseInr + b.markupInr + b.gstInr) * 100) / 100,
        `parts must sum to total for ${amt} @ ${rate}`);
    }
  });

  test("REGRESSION: the real Claude subscription charge", () => {
    // Transaction 5043: USD 23.60 on 2026-08-24, mid-market 95.76.
    const b = convertToInr(23.6, "USD", 95.76);
    assert.equal(b.baseInr, 2259.94);
    assert.equal(b.markupInr, 79.1);
    assert.equal(b.gstInr, 14.24);
    assert.equal(b.totalInr, 2353.28);
  });

  test("the total is about 4.13% above the bare conversion", () => {
    // 3.5% markup plus 18% GST on it = 1.035 x 1.0063 - the all-in uplift.
    const expected = (1 + FX_MARKUP_RATE) + FX_MARKUP_RATE * GST_ON_MARKUP_RATE;
    const b = convertToInr(1000, "USD", 90);
    assert.ok(Math.abs(b.totalInr / b.baseInr - expected) < 1e-9);
    assert.ok(Math.abs(expected - 1.0413) < 0.0001);
  });

  test("everything is rounded to paisa", () => {
    const b = convertToInr(33.33, "EUR", 97.777);
    for (const v of [b.baseInr, b.markupInr, b.gstInr, b.totalInr]) {
      assert.equal(v, Math.round(v * 100) / 100, `${v} must be whole paisa`);
    }
  });

  test("refuses a nonsense amount or rate rather than storing one", () => {
    // A zero or negative rate would silently zero out a real charge.
    assert.throws(() => convertToInr(10, "USD", 0));
    assert.throws(() => convertToInr(10, "USD", -90));
    assert.throws(() => convertToInr(10, "USD", Number.NaN));
    assert.throws(() => convertToInr(-10, "USD", 90));
  });

  test("the audit line names every component", () => {
    const line = describeBreakdown(convertToInr(23.6, "USD", 95.76));
    for (const part of ["USD 23.6", "95.76", "2259.94", "79.1", "14.24", "2353.28", "3.5%", "18%"]) {
      assert.ok(line.includes(part), `audit line should mention ${part}: ${line}`);
    }
  });
});

describe("isConvertibleForeignCard", () => {
  const charge = {
    currency: "USD", amount: 23.6, type: "debit",
    status: "success", paymentMethod: "card", transactionDate: "2026-08-24",
  };

  test("a real foreign card charge converts", () => {
    assert.equal(isConvertibleForeignCard(charge), true);
    assert.equal(isConvertibleForeignCard({ ...charge, currency: "EUR" }), true);
    // A foreign refund is money moving too.
    assert.equal(isConvertibleForeignCard({ ...charge, type: "credit" }), true);
  });

  test("INR and missing currencies are left alone", () => {
    assert.equal(isConvertibleForeignCard({ ...charge, currency: "INR" }), false);
    assert.equal(isConvertibleForeignCard({ ...charge, currency: null }), false);
  });

  test("MUST NOT CONVERT: a standing-instruction ceiling that was never charged", () => {
    // "Merchant: Anthropic, Maximum Amount: USD 150.00" is a mandate notice,
    // not a charge. Converting it would invent Rs 15,000 of spend that never
    // happened. It classifies as `ignored`, which is what excludes it.
    assert.equal(isConvertibleForeignCard({ ...charge, type: "ignored", amount: 150 }), false);
  });

  test("MUST NOT CONVERT: a declined or withheld transaction", () => {
    // The amount is quoted but never left the account.
    assert.equal(isConvertibleForeignCard({ ...charge, status: "failed" }), false);
    assert.equal(isConvertibleForeignCard({ ...charge, status: null }), false);
  });

  test("MUST NOT CONVERT: a non-card rail", () => {
    // Scope is card transactions; a foreign-denominated mandate is not one.
    assert.equal(isConvertibleForeignCard({ ...charge, paymentMethod: "mandate" }), false);
    assert.equal(isConvertibleForeignCard({ ...charge, paymentMethod: null }), false);
  });

  test("MUST NOT CONVERT: no date to price the rate on", () => {
    assert.equal(isConvertibleForeignCard({ ...charge, transactionDate: null }), false);
  });

  test("MUST NOT CONVERT: a zero or missing amount", () => {
    assert.equal(isConvertibleForeignCard({ ...charge, amount: 0 }), false);
    assert.equal(isConvertibleForeignCard({ ...charge, amount: null }), false);
  });
});
