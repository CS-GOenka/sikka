// Keying the merchant cache.
//
// The tests are symmetrical on purpose. Variants of one merchant must collapse
// to a single key, and merchants that merely resemble each other must stay
// apart. Over-merging is the worse failure of the two, because it silently
// files one budget's spending under another's and nothing surfaces the error.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { payeeKey } from "../payeeKey.ts";

const sameKey = (...payees: string[]) => new Set(payees.map(payeeKey)).size === 1;

describe("payeeKey", () => {
  test("folds the casing variants ICICI actually sends for one merchant", () => {
    // All of these appear in production for the same card: the bank varies the
    // case, and cleanPayee() only proper-cases the all-caps form.
    assert.ok(sameKey("RAZ*Swiggy", "RAZ*SWIGGY", "Raz*swiggy", "Raz*Swiggy"));
  });

  test("strips the payment-gateway prefix, which names the acquirer not the merchant", () => {
    assert.ok(sameKey("Swiggy", "RAZ*Swiggy", "CAS*Swiggy", "Ing*Swiggy"));
    assert.equal(payeeKey("RAZ*Zepto"), payeeKey("Zepto"));
  });

  test("strips www prefixes and domain tails", () => {
    assert.ok(sameKey("Swiggy", "Www Swiggy", "Www Swiggy Com", "Www Swiggy In"));
    assert.equal(payeeKey("Bookmyshow Com"), payeeKey("Bookmyshow"));
    assert.equal(payeeKey("Www Airtel In"), payeeKey("Airtel"));
  });

  test("strips legal-entity suffixes, including stacked ones", () => {
    assert.ok(sameKey("Swiggy", "Swiggy Limited", "Swiggy Ltd", "Swiggy Pvt Ltd"));
    assert.ok(sameKey("Zomato", "Zomato Ltd", "Zomato Limited"));
    assert.equal(payeeKey("Raz*Swiggy Tech"), payeeKey("Swiggy"));
  });

  test("resolves the whole real-world Swiggy family to one key", () => {
    assert.ok(
      sameKey(
        "Swiggy", "Swiggy Limited", "Swiggy Ltd", "Swiggy Pvt Ltd", "Swiggy Food",
        "CAS*Swiggy", "RAZ*Swiggy", "Raz*swiggy", "Ing*Swiggy", "Raz*Swiggy Tech",
        "Www Swiggy", "Www Swiggy Com", "Www Swiggy In"
      )
    );
  });

  test("keeps Swiggy's genuinely different products apart", () => {
    // Instamart is groceries and Dineout is a restaurant bill. Merging these
    // into food delivery would mis-file real spending, so a shared leading
    // word must never be enough on its own.
    assert.notEqual(payeeKey("Swiggy Instamar"), payeeKey("Swiggy"));
    assert.notEqual(payeeKey("Swiggy Dineout"), payeeKey("Swiggy"));
    assert.notEqual(payeeKey("Swiggy Diners"), payeeKey("Swiggy"));
    assert.notEqual(payeeKey("Ind*amazon.in - Grocer"), payeeKey("IND*Amazon"));
  });

  test("keeps different people with a shared first name apart", () => {
    assert.notEqual(payeeKey("Subham Goenka"), payeeKey("Subham Verma"));
    assert.notEqual(payeeKey("Subham"), payeeKey("Subham Goenka"));
  });

  test("does not strip a 5+ letter word before a star, which is not a gateway code", () => {
    assert.equal(payeeKey("Merch*Coffee"), "merch*coffee");
  });

  test("collapses and trims whitespace", () => {
    assert.equal(payeeKey("  Swiggy   Limited "), "swiggy");
    assert.equal(payeeKey("Swiggy\tLimited"), "swiggy");
  });

  test("is idempotent, so re-keying an already-keyed row is a no-op", () => {
    for (const raw of ["RAZ*SWIGGY", "Www Swiggy Com", "Swiggy Pvt Ltd", "IND*Amazon.in -"]) {
      const once = payeeKey(raw);
      assert.equal(payeeKey(once), once, `not idempotent for ${raw}`);
    }
  });
});
