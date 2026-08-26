// Recognising a transaction that is already captured.
//
// The point of these tests is symmetrical: a re-share must be ignored, and the
// things that merely LOOK like a re-share must not be. Suppressing a real
// transaction is the worse failure of the two, because it is silent.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractReference,
  findExistingCapture,
  type CandidateTransaction,
  type DuplicateLookups,
  type FingerprintInput,
} from "../duplicateCheck.ts";
import {
  CARD_SWIPE_NO_REF,
  IMPS_REF,
  LATE_REFUND,
  REVERSAL_QUOTING_DEBIT,
  SAME_DAY,
  TRUNCATED_A,
  TRUNCATED_B,
  UPI_COLON_REF,
} from "./fixtures.ts";

/** A stand-in database. Records what it was asked, so the tests can assert on that too. */
function lookups(options: {
  byReference?: Record<string, CandidateTransaction[]>;
  fingerprintHit?: number | null;
  throwOnReference?: boolean;
  throwOnFingerprint?: boolean;
} = {}): DuplicateLookups & { referenceQueries: string[]; fingerprintQueries: FingerprintInput[] } {
  const referenceQueries: string[] = [];
  const fingerprintQueries: FingerprintInput[] = [];
  return {
    referenceQueries,
    fingerprintQueries,
    async byReference(reference) {
      referenceQueries.push(reference);
      if (options.throwOnReference) throw new Error("simulated lookup failure");
      return options.byReference?.[reference] ?? [];
    },
    async byFingerprint(input) {
      fingerprintQueries.push(input);
      if (options.throwOnFingerprint) throw new Error("simulated lookup failure");
      return options.fingerprintHit ?? null;
    },
  };
}

const DEBIT_16748 = { type: "debit", amount: 16748, transactionDate: "2026-08-19", cardOrAccount: "XX7001", payee: "UPI-62314678782" };

describe("extractReference", () => {
  test("reads every reference shape this account receives", () => {
    assert.equal(extractReference(SAME_DAY), "660111284688");            // UPI-<ref>-NAME
    assert.equal(extractReference(UPI_COLON_REF), "659827785171");       // UPI:<ref>
    assert.equal(extractReference(IMPS_REF), "512345678901");            // IMPS ref <ref>
    assert.equal(extractReference(REVERSAL_QUOTING_DEBIT), "660111284688");
  });

  test("REGRESSION: the truncated-URL pair yields the SAME reference", () => {
    // Transactions 5008 and 5011. The two texts differ only in the trailing
    // URL, so text comparison could never match them - the reference can.
    assert.notEqual(TRUNCATED_A, TRUNCATED_B);
    assert.equal(extractReference(TRUNCATED_A), "62314678782");
    assert.equal(extractReference(TRUNCATED_B), "62314678782");
    assert.equal(extractReference(TRUNCATED_A), extractReference(TRUNCATED_B));
  });

  test("returns null for a card-swipe alert, which carries no reference", () => {
    assert.equal(extractReference(CARD_SWIPE_NO_REF), null);
    assert.equal(extractReference(LATE_REFUND), null);
  });

  test("does not mistake a short number for a reference", () => {
    // Card tails, amounts and phone numbers must not be read as references.
    assert.equal(extractReference("Card XX7001 debited for INR 40.00"), null);
    assert.equal(extractReference("SMS BLOCK 7001 to 9215676766"), null);
  });
});

describe("reference match", () => {
  test("REGRESSION: the truncated-URL re-share is recognised as a duplicate", async () => {
    const db = lookups({ byReference: { "62314678782": [{ id: 5008, type: "debit", amount: 16748 }] } });
    const match = await findExistingCapture(
      { message: TRUNCATED_B, manualCapture: true, ...DEBIT_16748 },
      db
    );
    assert.equal(match?.transactionId, 5008);
    assert.match(match!.reason, /reference 62314678782/);
  });

  test("applies on the automatic path too - a reference identifies one movement of money", async () => {
    const db = lookups({ byReference: { "62314678782": [{ id: 5008, type: "debit", amount: 16748 }] } });
    const match = await findExistingCapture(
      { message: TRUNCATED_A, manualCapture: false, ...DEBIT_16748 },
      db
    );
    assert.equal(match?.transactionId, 5008);
  });

  test("MUST NOT SUPPRESS: a reversal quoting the debit's reference", async () => {
    // The reversal carries the same reference AND the same amount as the debit
    // it reverses. Only the type differs, which is why type is part of the key.
    const db = lookups({ byReference: { "660111284688": [{ id: 5031, type: "debit", amount: 79 }] } });
    const match = await findExistingCapture(
      {
        message: REVERSAL_QUOTING_DEBIT,
        manualCapture: true,
        type: "credit",
        amount: 79,
        transactionDate: "2026-08-23",
        cardOrAccount: "XX036",
        payee: null,
      },
      db
    );
    assert.equal(match, null, "a reversal must not be swallowed as a duplicate of its own debit");
  });

  test("MUST NOT SUPPRESS: same reference, different amount (a partial refund)", async () => {
    const db = lookups({ byReference: { "660111284688": [{ id: 5031, type: "debit", amount: 79 }] } });
    const match = await findExistingCapture(
      { message: SAME_DAY, manualCapture: true, type: "debit", amount: 40, transactionDate: "2026-08-23", cardOrAccount: "XX7001", payee: "SNABBIT" },
      db
    );
    assert.equal(match, null);
  });

  test("a stored message with no transaction is not a match", async () => {
    // A raw message can exist without a transaction if an earlier insert failed;
    // that is not a capture, so it must not block this one.
    const db = lookups({ byReference: { "62314678782": [] } });
    const match = await findExistingCapture(
      { message: TRUNCATED_A, manualCapture: false, ...DEBIT_16748 },
      db
    );
    assert.equal(match, null);
  });
});

describe("fingerprint match - reference-less messages", () => {
  const swipe = {
    message: CARD_SWIPE_NO_REF,
    type: "debit",
    amount: 194,
    transactionDate: "2026-08-15",
    cardOrAccount: "XX2003",
    payee: "Blinkit",
  };

  test("a manual re-share of a card-swipe alert is recognised", async () => {
    // Two in five transaction SMS carry no reference, so without this a
    // re-share of one would still double up.
    const db = lookups({ fingerprintHit: 4900 });
    const match = await findExistingCapture({ ...swipe, manualCapture: true }, db);
    assert.equal(match?.transactionId, 4900);
    assert.match(match!.reason, /same amount, date, card and payee/);
    assert.equal(db.fingerprintQueries.length, 1);
    assert.deepEqual(db.fingerprintQueries[0], {
      type: "debit", amount: 194, transactionDate: "2026-08-15", cardOrAccount: "XX2003", payee: "Blinkit",
    });
  });

  test("MUST NOT SUPPRESS: the same purchase twice on the automatic path", async () => {
    // Buying the same coffee twice in a day is real. The automatic path must
    // never drop the second one, so the fingerprint is not even consulted.
    const db = lookups({ fingerprintHit: 4900 });
    const match = await findExistingCapture({ ...swipe, manualCapture: false }, db);
    assert.equal(match, null);
    assert.equal(db.fingerprintQueries.length, 0, "the automatic path must not run a fingerprint query");
  });

  test("no fingerprint without both an amount and a date", async () => {
    // Otherwise this would match half the table.
    const db = lookups({ fingerprintHit: 4900 });
    assert.equal(await findExistingCapture({ ...swipe, manualCapture: true, amount: null }, db), null);
    assert.equal(await findExistingCapture({ ...swipe, manualCapture: true, transactionDate: null }, db), null);
    assert.equal(db.fingerprintQueries.length, 0);
  });

  test("REGRESSION: a reference that matches nothing means NEW, and the fingerprint never runs", async () => {
    // The poker-night bug. Five people paid Rs 500 each on one day, so
    // amount + date + card + payee matched an earlier payment and silently
    // swallowed a real one - even though the message carried its own distinct
    // UPI reference proving it was a different movement of money.
    const db = lookups({ byReference: {}, fingerprintHit: 7777 });
    const match = await findExistingCapture(
      { message: SAME_DAY, manualCapture: true, type: "credit", amount: 500, transactionDate: "2026-08-25", cardOrAccount: "XX036", payee: "Disha Goenka" },
      db
    );
    assert.equal(match, null, "a distinct reference must win over a fingerprint collision");
    assert.deepEqual(db.referenceQueries, ["660111284688"], "the reference was still checked");
    assert.equal(db.fingerprintQueries.length, 0, "the fingerprint must not get a second opinion");
  });

  test("REGRESSION: two payments from the SAME person on the same day both survive", async () => {
    // Not exotic - one person settling twice in an evening. Each SMS carries
    // its own reference, which is what distinguishes them.
    const db = lookups({ byReference: {}, fingerprintHit: 4242 });
    for (const ref of ["660385464217", "999111222333"]) {
      const match = await findExistingCapture(
        {
          message: `Dear Customer, Acct XX036 is credited with Rs 500.00 on 25-Aug-26 from DISHA GOENKA. UPI:${ref}-ICICI Bank.`,
          manualCapture: true, type: "credit", amount: 500,
          transactionDate: "2026-08-25", cardOrAccount: "XX036", payee: "Disha Goenka",
        },
        db
      );
      assert.equal(match, null, `payment with reference ${ref} must be kept`);
    }
  });
});

describe("a failed lookup must not block ingest", () => {
  test("a reference lookup failure falls through rather than throwing", async () => {
    // Losing a message is worse than storing a duplicate, which is visible.
    const db = lookups({ throwOnReference: true, fingerprintHit: null });
    const match = await findExistingCapture(
      { message: TRUNCATED_A, manualCapture: false, ...DEBIT_16748 },
      db
    );
    assert.equal(match, null);
  });

  test("a fingerprint lookup failure falls through rather than throwing", async () => {
    const db = lookups({ throwOnFingerprint: true });
    const match = await findExistingCapture(
      { message: CARD_SWIPE_NO_REF, manualCapture: true, type: "debit", amount: 194, transactionDate: "2026-08-15", cardOrAccount: "XX2003", payee: "Blinkit" },
      db
    );
    assert.equal(match, null);
  });
});
