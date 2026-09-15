/**
 * One transaction, in the shape the detail view needs.
 *
 * /transactions and the dashboard reach a transaction by different routes and
 * hold different row types, and they used to describe it differently once they
 * got there - the list expanded ten fields inline, the dashboard opened a sheet
 * with six. The sheet left out type, status, currency and transfer on the
 * grounds that every row reaching it is a successful non-transfer INR debit by
 * construction, which is true but meant the same transaction read as two
 * different objects depending on where you tapped it.
 *
 * So there is one shape and one field set. The dashboard fills the four
 * constant fields with the values its own query guarantees rather than hiding
 * them.
 */
export interface TxnDetail {
  id: number;
  payee: string | null;
  amount: number | null;
  currency: string;
  /** Already formatted for display - the two callers have different sources. */
  receivedFull: string;
  transactionDate: string | null;
  type: string;
  paymentMethod: string | null;
  status: string | null;
  accountType: string | null;
  cardOrAccount: string | null;
  note: string | null;
  isTransfer: boolean;
  starred: boolean;
  categoryName: string | null;
  /** The settlement group this is a daughter of, if any. */
  groupName: string | null;
}
