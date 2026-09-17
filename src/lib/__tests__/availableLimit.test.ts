// Reading the figure the bank leaves at the end of an alert, and knowing when
// it settles a question.
//
// This is the only field that distinguishes a genuine repeat purchase from a
// re-captured one: amount, date, card and merchant are identical in both cases.
// Measured across this account's history it separates 23 of 23 falsely-collapsed
// pairs, so the parsing has to hold for every spelling ICICI uses.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractAvailableLimit, provesDistinct } from "../availableLimit.ts";
import { CARD_SWIPE_NO_REF, TRUNCATED_A, UPI_COLON_REF } from "./fixtures.ts";

describe("extractAvailableLimit", () => {
  test("reads the credit-card spellings", () => {
    assert.equal(extractAvailableLimit(CARD_SWIPE_NO_REF), 47258.57);   // "Avl Limit: INR"
    assert.equal(extractAvailableLimit(TRUNCATED_A), 67815);            // "Avl Lmt: Rs"
  });

  test("reads the savings-account balance", () => {
    // A different quantity, but it moves the same way and is only ever compared
    // against another figure from the same account.
    assert.equal(
      extractAvailableLimit("ICICI Bank Acc XX036 debited Rs. 43,500.00 on 04-Sep-26 InfoBIL*NEFT*IN12.Avl Bal Rs. 4,60,024.28"),
      460024.28
    );
  });

  test("reads the email phrasing", () => {
    assert.equal(
      extractAvailableLimit("The Available Credit Limit on your card is INR 1,24,913.27 and Total Credit Limit is INR 3,15,900.00."),
      124913.27
    );
  });

  test("returns null when the alert quotes nothing", () => {
    assert.equal(extractAvailableLimit(UPI_COLON_REF), null);
    assert.equal(extractAvailableLimit(""), null);
    assert.equal(extractAvailableLimit(null), null);
  });

  test("a maxed-out card reporting zero is a real reading, not a missing one", () => {
    assert.equal(extractAvailableLimit("Rs 100.00 spent on ICICI Bank Card XX2003 on 01-Jan-26 at X. Avl Lmt: Rs 0.00"), 0);
  });
});

describe("provesDistinct", () => {
  test("different figures prove two different movements of money", () => {
    assert.equal(provesDistinct(14916.13, 11170.13), true);
  });

  test("equal figures prove nothing - a re-delivered alert repeats the figure", () => {
    assert.equal(provesDistinct(67815, 67815), false);
  });

  test("a missing figure proves nothing", () => {
    assert.equal(provesDistinct(null, 67815), false);
    assert.equal(provesDistinct(67815, undefined), false);
  });

  test("tolerates float noise rather than calling it a difference", () => {
    assert.equal(provesDistinct(1000.0, 1000.001), false);
    assert.equal(provesDistinct(1000.0, 1000.01), true);
  });
});
