/**
 * The account state the bank quoted after a transaction.
 *
 * Every ICICI alert that touches money ends by saying what is left: a credit
 * card quotes the available credit limit, a savings account the available
 * balance. They are different quantities, but for the one job this serves they
 * behave identically - both move with every transaction, so two alerts that
 * report the SAME figure cannot describe two different movements of money.
 *
 * That makes this the only field in an SMS capable of telling a genuine repeat
 * purchase from a re-captured one. Amount, date, card and merchant are all
 * identical in both cases; the trailing figure is not. Buying the same coffee
 * twice leaves two different balances behind it.
 *
 * Stored under one name because it is only ever compared between two rows on
 * the same card or account - the duplicate fingerprint pins card_or_account
 * before this is consulted - so a limit is never weighed against a balance.
 */

// Four spellings, in the order they appear across alert types. Ordered by
// specificity: the credit-card forms are matched before "Avl Bal", which is a
// savings-account phrase, so a message carrying both is read as the card it is.
const PATTERNS = [
  /Avl\s*(?:Limit|Lmt)\s*:?\s*(?:INR|Rs\.?)\s*([\d,]+\.?\d*)/i,
  /Available\s*(?:Credit\s*)?Limit(?:\s+on\s+your\s+card)?\s*(?:is)?\s*:?\s*(?:INR|Rs\.?)\s*([\d,]+\.?\d*)/i,
  /Avl\s*Bal[^\d]{0,12}(?:INR|Rs\.?)?\s*([\d,]+\.?\d*)/i,
];

export function extractAvailableLimit(message: string | null | undefined): number | null {
  const text = String(message ?? "");
  for (const pattern of PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number(match[1].replace(/,/g, ""));
    // A zero is real - a maxed-out card reports 0.00 - but a negative or a
    // non-number means the pattern matched something that was not a figure.
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/**
 * Do two alerts prove they describe different movements of money?
 *
 * Only ever a veto, never a confirmation. Differing figures are proof of two
 * distinct events; equal figures prove nothing either way, because the bank
 * sends the same figure on a genuine re-delivery of one alert. Absent figures
 * prove nothing at all. So this answers "definitely not a duplicate" and leaves
 * every other case to the checks that already exist.
 */
export function provesDistinct(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) >= 0.005;
}
