// What the classifier is allowed to call a merchant.
//
// The asymmetry here is deliberate, and it is the whole point of the test file:
// a merchant name wrongly dropped costs one review click, while a non-merchant
// wrongly kept propagates - into merchant_categories as a key that can never be
// hit again, and into the model as a string it will confidently miscategorize.
// So the link rule is tested from both sides, and the "must survive" side has
// more cases than the "must be rejected" side.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../classify.ts";
import { LINK_INSTEAD_OF_MERCHANT, DOMAIN_SHAPED_MERCHANTS, CARD_SWIPE_NO_REF } from "./fixtures.ts";

describe("classify: links in the merchant slot", () => {
  test("does not treat a tracking link as a merchant name", () => {
    const r = classify(LINK_INSTEAD_OF_MERCHANT);
    assert.equal(r.payee, null);
  });

  test("keeps the rest of the transaction, which is still trustworthy", () => {
    // The bug being fixed was never about the amount or the card - those parse
    // correctly. Dropping the row would lose real spend to fix a naming bug.
    const r = classify(LINK_INSTEAD_OF_MERCHANT);
    assert.equal(r.type, "debit");
    assert.equal(r.amount, 181);
    assert.equal(r.cardOrAccount, "XX2003");
    assert.equal(r.transactionDate, "2026-06-14");
    assert.equal(r.status, "success");
  });

  test("preserves the link in the note, so review can still trace the charge", () => {
    const r = classify(LINK_INSTEAD_OF_MERCHANT);
    assert.equal(r.note, "https://icici.co/ICICIT/yoDJsE");
  });

  test("keeps merchant names that merely contain a domain", () => {
    // AGODA.COM, WWW.HOSTELWORLD and 2CO.com are merchants, not links. A rule
    // that keyed on "contains a dot" or "starts with www" would eat all three.
    const payees = DOMAIN_SHAPED_MERCHANTS.map((m) => classify(m).payee);
    assert.deepEqual(payees, ["Agoda.com The M", "Www.hostelworld", "2CO.com*shop.mb"]);
  });

  test("leaves an ordinary merchant untouched", () => {
    assert.equal(classify(CARD_SWIPE_NO_REF).payee, "Blinkit");
  });
});
