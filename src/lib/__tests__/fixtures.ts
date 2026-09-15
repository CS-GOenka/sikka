// Real messages from this account, kept verbatim.
//
// Every one of these is a message that actually arrived and that drove a bug or
// a deliberate design decision. Paraphrasing them would lose the exact detail
// each is here to pin down - the truncated URL, the reference format, the
// wording that carries a date.

/** The 22-Aug transactions filed under 23-Aug because the Share Sheet sent a Current Date. */
export const SHARED_22_AUG =
  "ICICI Bank Credit Card XX7001 debited for INR 40.00 on 22-Aug-26 for UPI-660093033295-AADRI. To dispute call 18001080/SMS BLOCK 7001 to 9215676766";

/** A same-day capture: the date in the text is today's. */
export const SAME_DAY =
  "ICICI Bank Credit Card XX7001 debited for INR 79.00 on 23-Aug-26 for UPI-660111284688-SNABBIT. To dispute call 18001080/SMS BLOCK 7001 to 9215676766";

/**
 * A refund the bank notified three days late. The date in the text (27-SEP) is
 * genuinely older than the receipt time, and the receipt time is CORRECT - this
 * is the case that makes "message older than receipt = misdated" a false rule.
 */
export const LATE_REFUND =
  "BLINKIT refund of Rs 449.00 credited to ICICI Bank Credit Card XX2003 on 27-SEP-25. Revised total due Rs 0, minimum due Rs .00";

/**
 * The duplicate pair already in the data (transactions 5008 and 5011), both
 * Rs 16,748 on 19-Aug. They differ ONLY in the trailing URL, which is why text
 * comparison could never catch them - but the UPI reference is identical.
 */
export const TRUNCATED_A =
  "Rs 16,748.00 spent on ICICI Bank Card XX7001 on 19-Aug-26 at UPI-62314678782. Avl Lmt: Rs 67,815.00. To dispute, call 18002662/SMS BLOCK 7001 to 9215676766. To convert this txn to EMI give a missed call on 9924667667. Know more about EMI conversion at https://icici.co/ICICIT/j/062b8875";
export const TRUNCATED_B =
  "Rs 16,748.00 spent on ICICI Bank Card XX7001 on 19-Aug-26 at UPI-62314678782. Avl Lmt: Rs 67,815.00. To dispute, call 18002662/SMS BLOCK 7001 to 9215676766. To convert this txn to EMI give a missed call on 9924667667. Know more about EMI conversion at";

/** A card-swipe alert. Two in five transaction SMS look like this: no reference at all. */
export const CARD_SWIPE_NO_REF =
  "INR 194.00 spent using ICICI Bank Card XX2003 on 15-Aug-26 on Blinkit. Avl Limit: INR 47,258.57";

/** A reversal, which quotes the reference of the DEBIT it reverses. */
export const REVERSAL_QUOTING_DEBIT =
  "Account XX036 has been credited with Rs 79.00 on 23-Aug-26 as reversal of transaction with UPI: 660111284688";

/** Other reference shapes that must still be recognised. */
export const UPI_COLON_REF =
  "ICICI Bank Acct XX036 debited for Rs 3390.00 on 20-Aug-26; CHANDRASHEKHARA credited. UPI:659827785171. Call 18002662 for dispute.";
export const IMPS_REF =
  "ICICI Bank Acct XX036 credited with Rs 500.00 on 12-Jul-26 from linked mobile acct 9876543210, IMPS ref 512345678901";

/**
 * The merchant slot filled with a tracking link instead of a name (raw_message
 * 616, transaction 1380). The email alert for the same charge names the real
 * merchant: www.swiggy.com. Parsed as a merchant, this link became a
 * merchant_categories key and was filed under "Other" by the model.
 */
export const LINK_INSTEAD_OF_MERCHANT =
  "INR 181.00 spent using ICICI Bank Card XX2003 on 14-Jun-26 on https://icici.co/ICICIT/yoDJsE. Avl Limit: INR 75,456.71. If not you, call 1800 2662/SMS BLOCK 2003 to 9215676766.";

/** Real merchant names that contain a domain and must NOT be mistaken for links. */
export const DOMAIN_SHAPED_MERCHANTS = [
  "Rs 39,113.27 spent on ICICI Bank Card XX2003 on 04-Apr-26 at AGODA.COM THE M. Avl Lmt: Rs 1,25,214.16",
  "Rs 2,396.22 spent on ICICI Bank Card XX2003 on 14-Apr-26 at WWW.HOSTELWORLD. Avl Lmt: Rs 33,196.71",
  "Rs 10,673.80 spent on ICICI Bank Card XX2003 on 27-Jul-24 at 2CO.com*shop.mb. Avl Lmt: Rs 33,196.71",
];
