// Recognising a transaction that is already captured.
//
// The Share Sheet makes accidental re-capture easy: an SMS the automation
// already ingested gets shared by hand, and the same spend lands twice. The
// exact-text dedup in the ingest route catches a byte-identical re-send, but
// two captures of the SAME message are not always byte-identical - the observed
// pair (transactions 5008 and 5011, both Rs 16,748 on 19-Aug) differs only in
// that one copy kept the trailing EMI-conversion URL and the other truncated
// it. No amount of text matching would have caught that; the bank's own
// reference number in both copies is identical.

// Relative with the extension, not the "@/" alias: this module is deliberately
// importable without a bundler - the decision logic is tested against stub
// lookups under node --test, and that runner does not read tsconfig paths.
import { extractAvailableLimit, provesDistinct } from "./availableLimit.ts";

// The bank's transaction reference: "UPI:659827785171", "UPI-660093033295-NAME",
// "UPI Ref. no. 123456789", "IMPS ref 987654321". Nine digits or more, which is
// short of every real reference seen and long enough not to collide with an
// amount, a card tail or a phone number in the same text.
const REFERENCE_RE =
  /(?:UPI[:\-\s]?|UPI\s*Ref\.?\s*no\.?\s*|IMPS\s*ref\s*|Ref(?:erence)?\s*(?:no\.?|number)?[:\s])\s*(\d{9,})/i;

export function extractReference(message: string): string | null {
  return REFERENCE_RE.exec(message)?.[1] ?? null;
}

export interface DuplicateMatch {
  transactionId: number;
  /** Why it matched, for the server log. */
  reason: string;
}

/** A stored transaction that quotes the same reference as the incoming message. */
export interface CandidateTransaction {
  id: number;
  type: string;
  amount: number | null;
}

export interface FingerprintInput {
  type: string;
  amount: number;
  transactionDate: string;
  cardOrAccount: string | null;
  payee: string | null;
}

/** A stored transaction matching the fingerprint, with the figure that can veto it. */
export interface FingerprintCandidate {
  id: number;
  availableLimit: number | null;
}

/**
 * The two database lookups this module needs. Passed in rather than imported so
 * the decision logic can be tested without a database - the part worth testing
 * is which candidate counts as a duplicate, not how the rows were fetched.
 */
export interface DuplicateLookups {
  byReference(reference: string): Promise<CandidateTransaction[]>;
  byFingerprint(input: FingerprintInput): Promise<FingerprintCandidate | null>;
}

/**
 * Is this message a re-capture of a transaction that is already stored?
 *
 * Two keys, deliberately different in strictness:
 *
 * 1. The bank's reference number, checked for EVERY sender. A reference
 *    identifies one movement of money, so this is safe on the automatic path
 *    too. It is NOT matched on its own, though: a refund SMS quotes the
 *    reference of the debit it reverses ("as reversal of transaction with
 *    UPI: 654194353908"), so reference alone would swallow legitimate
 *    reversals. Type and amount must agree as well - a reversal is a credit
 *    against the original's debit, so it still gets through.
 *
 * 2. Amount + date + card + payee, checked only for MANUAL captures AND only
 *    for messages with no reference at all. Roughly two in five transaction SMS
 *    are like that - card-swipe alerts such as "INR 194.00 spent using ICICI
 *    Bank Card XX2003 on 15-Aug-26 on Blinkit" - so without this a re-share of
 *    one would still double up.
 *
 *    It is confined to manual captures because buying the same coffee twice in
 *    a day is real and the automatic path must not drop the second one. It is
 *    confined to reference-less messages because a reference already answers
 *    the question definitively, and this fingerprint answers it badly: five
 *    people paying Rs 500 each at a poker night, or one person paying twice in
 *    a day, are indistinguishable to it.
 */
export async function findExistingCapture(
  input: {
    message: string;
    manualCapture: boolean;
    type: string;
    amount: number | null;
    transactionDate: string | null;
    cardOrAccount: string | null;
    payee: string | null;
  },
  lookups: DuplicateLookups
): Promise<DuplicateMatch | null> {
  const reference = extractReference(input.message);
  if (reference) {
    let candidates: CandidateTransaction[] = [];
    try {
      candidates = await lookups.byReference(reference);
    } catch (err) {
      // A failed lookup must not block ingest: losing a message is worse than
      // storing a duplicate, which is visible and can be deleted.
      console.error("Duplicate check by reference failed:", err);
    }
    for (const candidate of candidates) {
      if (candidate.type !== input.type) continue; // a reversal quotes the original's reference
      if (candidate.amount !== input.amount) continue;
      return { transactionId: candidate.id, reason: `reference ${reference}` };
    }
  }

  // A message carrying a bank reference has already been judged on it. The
  // reference identifies one movement of money, so if it matched nothing then
  // this is a new transaction - full stop - and the fingerprint must not get a
  // second opinion. It would be a worse one: at a poker night five people pay
  // Rs 500 each on the same day, and two payments from the SAME person on one
  // day are ordinary. Amount + date + card + payee cannot tell those apart,
  // and silently swallowed real transactions that the reference proved were
  // distinct.
  if (reference) return null;

  if (!input.manualCapture) return null;
  // Reference-less messages only - card-swipe alerts like "INR 194.00 spent
  // using ICICI Bank Card XX2003 on 15-Aug-26 on Blinkit", which carry nothing
  // else to identify them by. Needs an amount and a date at the very least, or
  // this would match half the table.
  if (input.amount === null || !input.transactionDate) return null;

  let candidate: FingerprintCandidate | null = null;
  try {
    candidate = await lookups.byFingerprint({
      type: input.type,
      amount: input.amount,
      transactionDate: input.transactionDate,
      cardOrAccount: input.cardOrAccount,
      payee: input.payee,
    });
  } catch (err) {
    console.error("Duplicate check by fingerprint failed:", err);
    return null;
  }
  if (candidate === null) return null;

  // The veto. Every alert that moves money ends by saying what is left, and two
  // alerts reporting DIFFERENT figures cannot describe the same movement - so a
  // fingerprint match with differing limits is two real charges, not a
  // re-capture. This is the only field that can tell them apart; amount, date,
  // card and merchant are identical either way.
  //
  // Measured against this account's whole history, it separates 23 of the 23
  // pairs this path would otherwise have collapsed - eleven ₹1 transfers to one
  // person on one day, thirteen months of identical ₹7,500 investment debits,
  // and same-day repeat orders from Zepto, Swiggy and Rentomojo. The one
  // genuine duplicate in the data reports the same figure twice and is
  // unaffected, and is caught by the reference check above in any case.
  //
  // Strictly a veto: equal figures prove nothing, because a re-delivered alert
  // repeats the figure, and an absent figure proves nothing at all. Both fall
  // through to the behaviour that was here before.
  const incomingLimit = extractAvailableLimit(input.message);
  if (provesDistinct(incomingLimit, candidate.availableLimit)) {
    console.log(
      `Fingerprint matched transaction ${candidate.id} but the available limits differ ` +
        `(${candidate.availableLimit} stored vs ${incomingLimit} incoming); treating as a distinct charge.`
    );
    return null;
  }

  return {
    transactionId: candidate.id,
    reason: `same amount, date, card and payee (${input.amount} on ${input.transactionDate})`,
  };
}
