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
  const quarantine = (reason: string): ParsedAlert => ({
    ...base,
    status: "quarantine",
    quarantine_reason: reason,
    amount: null,
    card_last4: null,
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
