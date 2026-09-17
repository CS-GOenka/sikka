/**
 * Reading a credit-card transaction out of an ICICI alert.
 *
 * Fail closed. A row reaches 'success' only by matching the purchase template
 * outright and yielding every field; anything else is quarantined with the
 * reason and its financial fields left null, so a quarantined row cannot be
 * summed by accident. Across 984 alerts this produced 939 success and 45
 * quarantine, with zero structural parse failures - the 45 were set aside for
 * what they ARE (32 bill payments, 10 non-INR, 3 declines), not for being
 * unreadable.
 *
 * The body's own clock is never read. Card alerts print a 12-hour time with no
 * meridiem, so "04:19:02" is either 04:19 or 16:19 and the message contains
 * nothing that decides which. internalDate is authoritative for time.
 */
export interface ParsedAlert {
  gmail_message_id: string;
  internal_date: number;
  raw_body: string;
  status: "success" | "quarantine";
  quarantine_reason: string | null;
  amount: number | null;
  card_last4: string | null;
  payee_email: string | null;
  available_limit: number | null;
}

const num = (s: string | null | undefined): number | null =>
  s == null ? null : Number(String(s).replace(/,/g, ""));

/**
 * Which card an alert is about, from either spelling ICICI uses.
 *
 * Purchase alerts say "Credit Card XX2003". Bill-payment receipts say
 * "Credit Card account 4315 XXXX XXXX 2003" - the same card, written as a
 * masked PAN. Reading only the first spelling left card_last4 null on all 32
 * payment rows, and a payment is the one event that RAISES the available limit,
 * so the limit chain could not be reconciled without them. That is what forced
 * the completeness figure to be reported as an upper bound rather than a
 * measurement.
 *
 * The masked form takes the LAST group: the first four digits are the issuer
 * BIN, which is identical across every card on the account and identifies
 * nothing.
 */
const CARD_PLAIN = /Credit Card\s+XX(\d{4})/i;
const CARD_MASKED = /\d{4}\s+X{4}\s+X{4}\s+(\d{4})/i;

export function cardLast4(body: string): string | null {
  return body.match(CARD_PLAIN)?.[1] ?? body.match(CARD_MASKED)?.[1] ?? null;
}

export function parseCardAlert(input: {
  id: string;
  internalDate: string | number;
  body: string;
}): ParsedAlert {
  const base = {
    gmail_message_id: input.id,
    internal_date: Number(input.internalDate),
    raw_body: input.body,
  };
  // Quarantined rows keep the card but lose every value that can be summed or
  // spent. The point of nulling fields is that a quarantined row must never be
  // mistaken for money moved; a card number is an identifier, not an amount, and
  // knowing which card a bill payment landed on is what makes the limit chain
  // reconcilable.
  const quarantine = (reason: string): ParsedAlert => ({
    ...base,
    status: "quarantine",
    quarantine_reason: reason,
    amount: null,
    card_last4: cardLast4(input.body ?? ""),
    payee_email: null,
    available_limit: null,
  });

  const body = input.body ?? "";
  if (!body.trim()) return quarantine("empty body");
  // Both of these use the same "has been used for a transaction" wording as a
  // real purchase, so they have to be excluded before the template matches.
  if (/could not be completed/i.test(body)) return quarantine("declined transaction");
  if (/We have received payment/i.test(body)) return quarantine("bill payment, not a purchase");

  const used = body.match(
    /ICICI Bank Credit Card XX(\d{4}) has been used for a transaction of ([A-Z]{3}) ([\d,]+\.?\d*)/i
  );
  if (!used) return quarantine("does not match the purchase template");
  const [, card_last4, currency, amountRaw] = used;
  if (currency !== "INR") return quarantine(`non-INR currency: ${currency}`);

  // The merchant runs from "Info:" to the sentence after it. Anchored on
  // ". The Available" rather than the first period, because merchant names
  // legitimately contain them - "IND*Amazon.in - Grocer", "AGODA.COM THE M".
  const info = body.match(/Info:\s*(.+?)\.?\s+The Available Credit Limit/i);
  if (!info) return quarantine("no Info: merchant found");
  const payee_email = info[1].replace(/\.\s*$/, "").trim();
  if (!payee_email) return quarantine("empty merchant after Info:");

  const limit = body.match(/Available Credit Limit on your card is INR ([\d,]+\.?\d*)/i);
  if (!limit) return quarantine("no available credit limit found");

  const amount = num(amountRaw);
  if (amount === null || !Number.isFinite(amount) || amount <= 0) {
    return quarantine("unparseable or non-positive amount");
  }

  return {
    ...base,
    status: "success",
    quarantine_reason: null,
    amount,
    card_last4,
    payee_email,
    available_limit: num(limit[1]),
  };
}
