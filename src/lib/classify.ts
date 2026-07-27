// Faithful TypeScript port of the classify_v4.py regex-based classifier used
// throughout this project's development. Runs inline in /api/ingest so every
// message is classified automatically, with no manual/script intervention.

export type TransactionType = "debit" | "credit" | "ignored" | "needs_review";
export type PaymentMethod = "upi" | "neft" | "imps" | "card" | "mandate" | "ach" | "rtgs" | "unknown";
export type TransactionStatus = "success" | "pending" | "failed" | "revoked" | null;
export type AccountType = "savings" | "credit_card" | "unknown";

export interface ClassifyResult {
  type: TransactionType;
  paymentMethod: PaymentMethod;
  status: TransactionStatus;
  accountType: AccountType;
  isTransfer: boolean;
  cardOrAccount: string | null;
  payee: string | null;
  note: string | null;
  amount: number | null;
  currency: string;
  transactionDate: string | null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const AMOUNT_RE = String.raw`(?:Rs\.?|INR|USD|EUR|GBP|₹)\s?([\d,]+\.?\d*)`;
const DATE_RE = String.raw`(\d{1,2}[-/][A-Za-z]{3}[-/]?\d{2,4})`;
const ACCT_RE = String.raw`(X+\d+)`;
const CARD_RE = String.raw`Credit Card\s*(?:XX)?(\d+)`;

const KNOWN_CODE_LABELS: Record<string, string> = {
  nsecleari: "NSE Clearing",
};

function parseAmount(s: string | null | undefined): number | null {
  if (s == null) return null;
  return parseFloat(s.replace(/,/g, "").trim());
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function isValidDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function parseDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{1,2})[-/]([A-Za-z]{3})[-/]?(\d{2,4})/.exec(s.trim());
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monNum = MONTHS[m[2].toLowerCase()];
  if (!monNum) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  if (!isValidDate(year, monNum, day)) return null;
  return `${year}-${pad2(monNum)}-${pad2(day)}`;
}

function parseDateSlash(s: string | null | undefined): string | null {
  // DD/MM/YYYY format used in Standing Instruction messages.
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s.trim());
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (!isValidDate(year, month, day)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function detectCurrency(text: string, amountStartIdx: number): string {
  const prefix = text.slice(Math.max(0, amountStartIdx - 6), amountStartIdx);
  for (const code of ["USD", "EUR", "GBP"]) {
    if (new RegExp(String.raw`\b${code}\s*$`, "i").test(prefix)) return code;
  }
  return "INR";
}

function isUpperWord(w: string): boolean {
  return /[A-Z]/.test(w) && !/[a-z]/.test(w);
}
function isLowerWord(w: string): boolean {
  return /[a-z]/.test(w) && !/[A-Z]/.test(w);
}
function capitalize(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

// Proper-case a raw payee string without fabricating content. VPA-style
// (contains '@') and pure numeric/code tokens are left untouched.
function cleanPayee(raw: string | null): string | null {
  if (raw == null) return null;
  if (raw.includes("@")) return raw;
  const words = raw.split(" ");
  const cleaned: string[] = [];
  for (const w of words) {
    if (!w) continue;
    if (/\d/.test(w)) {
      cleaned.push(w);
    } else if (isUpperWord(w) || isLowerWord(w)) {
      cleaned.push(capitalize(w));
    } else {
      cleaned.push(w);
    }
  }
  return cleaned.join(" ");
}

// Generalized 'CODE*NAME' reference parser (e.g. VPS*THE PARK, VIN*SWIGGY IN,
// InfoACH*NSECleari). Strips an optional leading 'Info' and the 3-4 letter
// uppercase code, cleans the remainder as payee, preserves the untouched
// original (code included) as note.
function parseCodeName(rawRefIn: string): [string | null, string] {
  const rawRef = rawRefIn.trim();
  const m = /^(?:Info)?([A-Z]{3,4})\*(.+)$/.exec(rawRef);
  if (!m) return [rawRef, rawRef];
  const name = m[2].trim();
  return [cleanPayee(name), rawRef];
}

function result(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    type: "needs_review",
    paymentMethod: "unknown",
    status: null,
    accountType: "unknown",
    isTransfer: false,
    cardOrAccount: null,
    payee: null,
    note: null,
    amount: null,
    currency: "INR",
    transactionDate: null,
    ...overrides,
  };
}

export function classify(text: string | null | undefined): ClassifyResult {
  const t = (text ?? "").trim();
  const low = t.toLowerCase();
  let m: RegExpExecArray | null;

  // ================= 1. UPI debit (semicolon / & / , / and / . separator) =================
  m = new RegExp(
    String.raw`ICICI Bank Acc(?:t|ount)?\.?\s*${ACCT_RE}\s+debited (?:for|with)\s+${AMOUNT_RE}\s+on\s+${DATE_RE}\s*(?:;|&|,|\.|\sand\s)\s*(.+?)\s+credited\s*\.?\s*UPI:`,
    "i"
  ).exec(t);
  if (m) {
    const rawPayee = m[4].trim();
    const acct = m[1];
    const amount = parseAmount(m[2]);
    const currency = detectCurrency(t, m.index + m[0].indexOf(m[2]));
    const date_ = parseDate(m[3]);
    // CRED (and BillDesk) are third-party bill-payment apps: money moves
    // from this account to them, and they settle the actual card bill
    // internally. ICICI never sends a "payment received on your credit
    // card" confirmation for that internal step, so the separate
    // amount+date confirmation matcher structurally cannot catch these -
    // there is nothing to match against. Detected by payee name instead,
    // same as BillDesk.
    if (/billdesk/i.test(rawPayee) || /^cred(\s+club)?$/i.test(rawPayee.trim())) {
      return result({
        type: "debit", paymentMethod: "upi", status: "success",
        accountType: "savings", isTransfer: true, cardOrAccount: acct,
        payee: "Credit Card Bill Payment", note: t,
        amount, currency, transactionDate: date_,
      });
    }
    return result({
      type: "debit", paymentMethod: "upi", status: "success",
      accountType: "savings", isTransfer: false, cardOrAccount: acct,
      payee: cleanPayee(rawPayee), note: rawPayee,
      amount, currency, transactionDate: date_,
    });
  }

  // ================= 2. UPI debit, "towards linked <VPA>" wording =================
  m = new RegExp(
    String.raw`Account\s*${ACCT_RE}\s+has been debited for\s+${AMOUNT_RE}\s+on\s+${DATE_RE},\s+towards linked\s+(.+?)\.\s*UPI Ref\. no\.\s*(\d+)`,
    "i"
  ).exec(t);
  if (m) {
    const rawPayee = m[4].trim();
    const isBd = /billdesk/i.test(rawPayee);
    return result({
      type: "debit", paymentMethod: "upi", status: "success",
      accountType: "savings", isTransfer: isBd, cardOrAccount: m[1],
      payee: isBd ? "Credit Card Bill Payment" : cleanPayee(rawPayee),
      note: isBd ? t : rawPayee,
      amount: parseAmount(m[2]), currency: detectCurrency(t, m.index + m[0].indexOf(m[2])),
      transactionDate: parseDate(m[3]),
    });
  }

  // ================= 3. NEFT / RTGS / ACH credit into own account =================
  // Name segment after the second hyphen is optional - some real NEFT
  // references end "NEFT-REF-." with nothing between the trailing hyphen
  // and the period (e.g. "Info NEFT-HDFCN52025011007835680-."), not every
  // reference includes a separately-appended sender name.
  m = new RegExp(
    String.raw`ICICI Bank Account\s*${ACCT_RE}\s+credited:\s?${AMOUNT_RE}\s+on\s+${DATE_RE}\.\s*Info\s*NEFT-(\S+?)-(.*?)\.\s*Available Balance`,
    "i"
  ).exec(t);
  if (m) {
    const rawPayee = m[5].trim();
    return result({
      type: "credit", paymentMethod: "neft", status: "success",
      accountType: "savings", cardOrAccount: m[1],
      payee: rawPayee ? cleanPayee(rawPayee) : null, note: rawPayee || null,
      amount: parseAmount(m[2]), currency: detectCurrency(t, m.index + m[0].indexOf(m[2])),
      transactionDate: parseDate(m[3]),
    });
  }
  m = new RegExp(
    String.raw`ICICI Bank Account\s*${ACCT_RE}\s+has been credited with\s+${AMOUNT_RE}\s+on\s+${DATE_RE}\.\s*Info:\s*NEFT-(\S+?)-(.*?)\.\s*The Available Balance`,
    "i"
  ).exec(t);
  if (m) {
    const rawPayee = m[5].trim();
    return result({
      type: "credit", paymentMethod: "neft", status: "success",
      accountType: "savings", cardOrAccount: m[1],
      payee: rawPayee ? cleanPayee(rawPayee) : null, note: rawPayee || null,
      amount: parseAmount(m[2]), currency: detectCurrency(t, m.index + m[0].indexOf(m[2])),
      transactionDate: parseDate(m[3]),
    });
  }
  m = new RegExp(
    String.raw`ICICI Bank Account\s*${ACCT_RE}\s+credited:\s?${AMOUNT_RE}\s+on\s+${DATE_RE}\.\s*Info\s*RTGS-(.+?)\.\s*Available Balance`,
    "i"
  ).exec(t);
  if (m) {
    const raw = m[4].trim().replace(/-+$/, "");
    const parts = raw.split("-").filter((p) => p);
    const ref = parts.length ? parts[0] : raw;
    const name = parts.length > 1 ? parts[1] : null;
    return result({
      type: "credit", paymentMethod: "rtgs", status: "success",
      accountType: "savings", cardOrAccount: m[1],
      payee: name ? cleanPayee(name) : null, note: ref,
      amount: parseAmount(m[2]), currency: detectCurrency(t, m.index + m[0].indexOf(m[2])),
      transactionDate: parseDate(m[3]),
    });
  }
  m = new RegExp(
    String.raw`ICICI Bank Account\s*${ACCT_RE}\s+credited:\s?${AMOUNT_RE}\s+on\s+${DATE_RE}\.\s*Info\s*ACH\*(.+?)\.\s*Available Balance`,
    "i"
  ).exec(t);
  if (m) {
    const rawCode = m[4].trim();
    const label = KNOWN_CODE_LABELS[rawCode.toLowerCase()];
    return result({
      type: "credit", paymentMethod: "ach", status: "success",
      accountType: "savings", cardOrAccount: m[1],
      payee: label ?? cleanPayee(rawCode), note: rawCode,
      amount: parseAmount(m[2]), currency: detectCurrency(t, m.index + m[0].indexOf(m[2])),
      transactionDate: parseDate(m[3]),
    });
  }

  // ================= 4. IMPS credit (by Account linked to mobile number) =================
  m = new RegExp(
    String.raw`ICICI Bank Account\s*${ACCT_RE}\s+is credited with\s+${AMOUNT_RE}\s+.*?by Account linked to mobile number\s*${ACCT_RE}\.\s*IMPS Ref\. no\.\s*(\d+)`,
    "i"
  ).exec(t);
  if (m) {
    return result({
      type: "credit", paymentMethod: "imps", status: "success",
      accountType: "savings", cardOrAccount: m[1],
      payee: null, note: `linked mobile acct ${m[3]}, IMPS ref ${m[4]}`,
      amount: parseAmount(m[2]), currency: detectCurrency(t, m.index + m[0].indexOf(m[2])),
      transactionDate: null,
    });
  }

  // ================= 5. UPI credit "Acct X is credited with Rs...from NAME.UPI:" =================
  m = new RegExp(
    String.raw`Acc(?:t|ount)?\.?\s*${ACCT_RE}\s+is credited with\s+${AMOUNT_RE}\s+on\s+${DATE_RE}\s+from\s+(.+?)\.\s*UPI`,
    "i"
  ).exec(t);
  if (m) {
    const rawPayee = m[4].trim();
    return result({
      type: "credit", paymentMethod: "upi", status: "success",
      accountType: "savings", cardOrAccount: m[1],
      payee: cleanPayee(rawPayee), note: rawPayee,
      amount: parseAmount(m[2]), currency: detectCurrency(t, m.index + m[0].indexOf(m[2])),
      transactionDate: parseDate(m[3]),
    });
  }

  // ================= 6. IMPS between own accounts =================
  m = new RegExp(
    String.raw`ICICI Bank Acc(?:t|ount)?\.?\s*${ACCT_RE}\s+debited (?:for|with)\s+${AMOUNT_RE}\s+on\s+${DATE_RE}\s*&\s*(.+?)\s+credited\.IMPS:`,
    "i"
  ).exec(t);
  if (m) {
    const rawPayee = m[4].trim();
    return result({
      type: "debit", paymentMethod: "imps", status: "success",
      accountType: "savings", cardOrAccount: m[1],
      payee: cleanPayee(rawPayee), note: rawPayee,
      amount: parseAmount(m[2]), currency: detectCurrency(t, m.index + m[0].indexOf(m[2])),
      transactionDate: parseDate(m[3]),
    });
  }

  // ================= 7. Card spend =================
  m = new RegExp(
    String.raw`(?:Rs\.?|INR|USD|EUR|GBP)\s?([\d,]+\.?\d*)\s+spent\s+(?:using|on)\s+ICICI Bank Card\s*${ACCT_RE}\s+on\s+${DATE_RE}\s+(?:on|at)\s+(.+?)\s*\.?\s*Avl`,
    "i"
  ).exec(t);
  if (m) {
    const rawPayee = m[4].trim();
    const status: TransactionStatus = /\bdeclined\b|insufficient funds/i.test(t) ? "failed" : "success";
    return result({
      type: "debit", paymentMethod: "card", status,
      accountType: "credit_card", cardOrAccount: m[2],
      payee: cleanPayee(rawPayee), note: rawPayee,
      amount: parseAmount(m[1]), currency: detectCurrency(t, m.index + m[0].indexOf(m[1])),
      transactionDate: parseDate(m[3]),
    });
  }

  // ================= 8. Mandate: future-dated notice (not yet debited) -> ignored/pending =================
  if (/will be debited/i.test(t) && /auto\s*pay|create mandate|mandate/i.test(t)) {
    const mAmt = new RegExp(AMOUNT_RE, "i").exec(t);
    const mDate = new RegExp(DATE_RE, "i").exec(t);
    const mPayee = /towards\s+(?:Autopay for\s+)?(.+?),/i.exec(t);
    const mAcct = new RegExp(String.raw`(?:Savings\s+)?Account\s*${ACCT_RE}`, "i").exec(t);
    const rawPayee = mPayee ? mPayee[1].trim() : null;
    return result({
      type: "ignored", paymentMethod: "mandate", status: "pending",
      accountType: mAcct ? "savings" : "unknown",
      cardOrAccount: mAcct ? mAcct[1] : null,
      payee: cleanPayee(rawPayee), note: rawPayee,
      amount: mAmt ? parseAmount(mAmt[1]) : null,
      currency: mAmt ? detectCurrency(t, mAmt.index + mAmt[0].indexOf(mAmt[1])) : "INR",
      transactionDate: mDate ? parseDate(mDate[1]) : null,
    });
  }

  // ================= 9. Mandate debited (completed, past tense) =================
  if (/(?:has been debited|successfully debited).*towards.*(?:autopay|mandate)/i.test(t)) {
    const mAmt = new RegExp(AMOUNT_RE, "i").exec(t);
    const mDate = new RegExp(DATE_RE, "i").exec(t);
    const mPayee = /towards\s+(.+?)\s+for\b/i.exec(t);
    const mAcct = new RegExp(String.raw`Savings Account\s*${ACCT_RE}`, "i").exec(t);
    const rawPayee = mPayee ? mPayee[1].trim() : null;
    return result({
      type: "debit", paymentMethod: "mandate", status: "success",
      accountType: mAcct ? "savings" : "unknown",
      cardOrAccount: mAcct ? mAcct[1] : null,
      payee: cleanPayee(rawPayee), note: rawPayee,
      amount: mAmt ? parseAmount(mAmt[1]) : null,
      currency: mAmt ? detectCurrency(t, mAmt.index + mAmt[0].indexOf(mAmt[1])) : "INR",
      transactionDate: mDate ? parseDate(mDate[1]) : null,
    });
  }
  // 9b. "Ref No." variant (inherently past tense)
  m = new RegExp(
    String.raw`${AMOUNT_RE}\s+debited from ICICI Bank Savings Account\s*${ACCT_RE}\s+on\s+${DATE_RE}\s+towards\s+(.+?)\s+for\s+Create Mandate AutoPay Retrieval Ref No\.(\d+)`,
    "i"
  ).exec(t);
  if (m) {
    return result({
      type: "debit", paymentMethod: "mandate", status: "success",
      accountType: "savings", cardOrAccount: m[2],
      payee: cleanPayee(m[4].trim()), note: m[4].trim(),
      amount: parseAmount(m[1]), currency: detectCurrency(t, m.index + m[0].indexOf(m[1])),
      transactionDate: parseDate(m[3]),
    });
  }

  // ================= 10. Mandate revoked -> ignored, status preserved =================
  if (low.includes("mandate") && low.includes("revoked")) {
    const mAmt = new RegExp(AMOUNT_RE, "i").exec(t);
    const mPayee = /revoked towards\s+(.+?)\s+for\b/i.exec(t);
    const rawPayee = mPayee ? mPayee[1].trim() : null;
    return result({
      type: "ignored", paymentMethod: "mandate", status: "revoked",
      accountType: "unknown", cardOrAccount: null,
      payee: cleanPayee(rawPayee), note: rawPayee,
      amount: mAmt ? parseAmount(mAmt[1]) : null,
      currency: mAmt ? detectCurrency(t, mAmt.index + mAmt[0].indexOf(mAmt[1])) : "INR",
      transactionDate: null,
    });
  }

  // ================= 11. AutoPay mandate creation confirmation -> ignored/success =================
  m = new RegExp(
    String.raw`AutoPay mandate with \S+ is successfully created towards\s+(.+?)\s+from\s+${DATE_RE}`,
    "i"
  ).exec(t);
  if (m) {
    const mAmt = new RegExp(AMOUNT_RE, "i").exec(t);
    return result({
      type: "ignored", paymentMethod: "mandate", status: "success",
      accountType: "unknown", cardOrAccount: null,
      payee: cleanPayee(m[1].trim()), note: m[1].trim(),
      amount: mAmt ? parseAmount(mAmt[1]) : null,
      currency: mAmt ? detectCurrency(t, mAmt.index + mAmt[0].indexOf(mAmt[1])) : "INR",
      transactionDate: parseDate(m[2]),
    });
  }

  // ================= 12. ACH/Bill auto-debit =================
  m = new RegExp(
    String.raw`ICICI Bank Acc\.?\s*${ACCT_RE}\s+debited\s+${AMOUNT_RE}\s+on\s+${DATE_RE}\s+Info(ACH|BIL)\*(.+?)\.\s*Av[lb] Bal`,
    "i"
  ).exec(t);
  if (m) {
    const rawCode = m[5].trim();
    const label = KNOWN_CODE_LABELS[rawCode.toLowerCase()];
    const status: TransactionStatus = /\bdeclined\b|insufficient funds/i.test(t) ? "failed" : "success";
    return result({
      type: "debit", paymentMethod: "ach", status,
      accountType: "savings", cardOrAccount: m[1],
      payee: label ?? rawCode, note: rawCode,
      amount: parseAmount(m[2]), currency: detectCurrency(t, m.index + m[0].indexOf(m[2])),
      transactionDate: parseDate(m[3]),
    });
  }

  // ================= 13. UPI money-request push (generalized) -> pending =================
  if (low.includes("has requested money") && low.includes("approv")) {
    const mAmt = new RegExp(AMOUNT_RE, "i").exec(t);
    const mPayee = /^(?:Dear Customer,\s*)?(.+?)\s+has requested money/i.exec(t);
    const rawPayee = mPayee ? mPayee[1].trim() : null;
    return result({
      type: "debit", paymentMethod: "upi", status: "pending",
      accountType: "unknown", cardOrAccount: null,
      payee: cleanPayee(rawPayee), note: rawPayee,
      amount: mAmt ? parseAmount(mAmt[1]) : null,
      currency: mAmt ? detectCurrency(t, mAmt.index + mAmt[0].indexOf(mAmt[1])) : "INR",
      transactionDate: null,
    });
  }

  // ================= 14. Generalized "CODE*NAME" debit shapes (VPS/VIN etc) =================
  m = new RegExp(
    String.raw`transaction of\s+${AMOUNT_RE}\s+done on ICICI Bank Account\s*${ACCT_RE}\s+on\s+${DATE_RE}\.\s*Info:\s*(.+?)\s*\.\s*The Available Balance`,
    "i"
  ).exec(t);
  if (m) {
    const [payee, note] = parseCodeName(m[4]);
    return result({
      type: "debit", paymentMethod: "ach", status: "success",
      accountType: "savings", cardOrAccount: m[2],
      payee, note,
      amount: parseAmount(m[1]), currency: detectCurrency(t, m.index + m[0].indexOf(m[1])),
      transactionDate: parseDate(m[3]),
    });
  }
  m = new RegExp(
    String.raw`ICICI Bank Acc\.?\s*${ACCT_RE}\s+debited with\s+${AMOUNT_RE}\s+on\s+${DATE_RE}\.\s*(.+?)\.Av[lb] Bal`,
    "i"
  ).exec(t);
  if (m) {
    const [payee, note] = parseCodeName(m[4]);
    return result({
      type: "debit", paymentMethod: "ach", status: "success",
      accountType: "savings", cardOrAccount: m[1],
      payee, note,
      amount: parseAmount(m[2]), currency: detectCurrency(t, m.index + m[0].indexOf(m[2])),
      transactionDate: parseDate(m[3]),
    });
  }
  // 14b. NFS*CASH WDL* - ATM cash withdrawal via the National Financial
  // Switch, not a "merchant" to parse a name out of. Checked before the
  // generic CODE*NAME variants below since it'd otherwise also match those
  // (same message shape), just with a less clean parsed payee.
  if (low.includes("nfs*cash wdl")) {
    m = new RegExp(
      String.raw`ICICI Bank Acc\.?\s*${ACCT_RE}\s+debited\s+${AMOUNT_RE}\s+on\s+${DATE_RE}`,
      "i"
    ).exec(t);
    if (m) {
      return result({
        type: "debit", paymentMethod: "card", status: "success",
        accountType: "savings", cardOrAccount: m[1],
        payee: "Cash Withdrawal", note: "NFS*CASH WDL*",
        amount: parseAmount(m[2]), currency: detectCurrency(t, m.index + m[0].indexOf(m[2])),
        transactionDate: parseDate(m[3]),
      });
    }
  }
  // 14c. "Acc is debited with/debited Rs X on DATE CODE*NAME . Available/Avb/Avl bal"
  // (no period right after the date, unlike the variant above; recurring
  // UPI-mandate-style charges like "VIN*CLAUDE AI" or "VSI*GMATCLUB").
  m = new RegExp(
    String.raw`ICICI Bank Acc\.?\s*${ACCT_RE}\s+(?:is\s+)?debited(?:\s+with)?\s+${AMOUNT_RE}\s+on\s+${DATE_RE}\s+(.+?)\s*\.\s*(?:Available bal|Avb Bal|Avl Bal)`,
    "i"
  ).exec(t);
  if (m) {
    const [payee, note] = parseCodeName(m[4]);
    return result({
      type: "debit", paymentMethod: "ach", status: "success",
      accountType: "savings", cardOrAccount: m[1],
      payee, note,
      amount: parseAmount(m[2]), currency: detectCurrency(t, m.index + m[0].indexOf(m[2])),
      transactionDate: parseDate(m[3]),
    });
  }
  // 14d. Same shape, amount-first word order: "Rs X debited from ICICI Bank
  // Acc XX036 on DATE CODE*NAME. Bal Rs Y".
  m = new RegExp(
    String.raw`${AMOUNT_RE}\s+debited from ICICI Bank Acc\.?\s*${ACCT_RE}\s+on\s+${DATE_RE}\s+(.+?)\s*\.\s*(?:Bal|Avb Bal|Avl Bal)`,
    "i"
  ).exec(t);
  if (m) {
    const [payee, note] = parseCodeName(m[4]);
    return result({
      type: "debit", paymentMethod: "ach", status: "success",
      accountType: "savings", cardOrAccount: m[2],
      payee, note,
      amount: parseAmount(m[1]), currency: detectCurrency(t, m.index + m[0].indexOf(m[1])),
      transactionDate: parseDate(m[3]),
    });
  }

  // ================= 15. Standing Instruction family (Credit Card SIs) =================
  if (low.includes("standing instruction")) {
    const mCard = new RegExp(CARD_RE, "i").exec(t);
    const card = mCard ? mCard[1] : null;

    if (low.includes("could not be processed")) {
      const mAmt = new RegExp(AMOUNT_RE, "i").exec(t);
      const mPayee = /(?:for|towards Merchant)\s+(.+?)\s+for Standing Instruction/i.exec(t);
      const rawPayee = mPayee ? mPayee[1].trim() : null;
      return result({
        type: "ignored", paymentMethod: "mandate", status: "failed",
        accountType: "credit_card", cardOrAccount: card,
        payee: cleanPayee(rawPayee), note: rawPayee,
        amount: mAmt ? parseAmount(mAmt[1]) : null,
        currency: mAmt ? detectCurrency(t, mAmt.index + mAmt[0].indexOf(mAmt[1])) : "INR",
      });
    }

    if (low.includes("had to be paused")) {
      const mPayee = /for\s+(.+?)\s+on your ICICI Bank Credit Card/i.exec(t);
      const rawPayee = mPayee ? mPayee[1].trim() : null;
      return result({
        type: "ignored", paymentMethod: "mandate", status: "revoked",
        accountType: "credit_card", cardOrAccount: card,
        payee: cleanPayee(rawPayee), note: rawPayee,
      });
    }

    if (low.includes("has been cancelled")) {
      const mPayee = /Merchant:\s*(.+?),/i.exec(t);
      const rawPayee = mPayee ? mPayee[1].trim() : null;
      return result({
        type: "ignored", paymentMethod: "mandate", status: "revoked",
        accountType: "credit_card", cardOrAccount: card,
        payee: cleanPayee(rawPayee), note: rawPayee,
      });
    }

    if (low.includes("successfully processed")) {
      const mAmt = new RegExp(AMOUNT_RE, "i").exec(t);
      const mPayee = /(?:for|to Merchant)\s+(.+?),\s*as per/i.exec(t);
      const rawPayee = mPayee ? mPayee[1].trim() : null;
      const mDate = /Standing Instructions?\s+\S+,?\s*on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(t);
      return result({
        type: "debit", paymentMethod: "mandate", status: "success",
        accountType: "credit_card", cardOrAccount: card,
        payee: cleanPayee(rawPayee), note: rawPayee,
        amount: mAmt ? parseAmount(mAmt[1]) : null,
        currency: mAmt ? detectCurrency(t, mAmt.index + mAmt[0].indexOf(mAmt[1])) : "INR",
        transactionDate: mDate ? parseDateSlash(mDate[1]) : null,
      });
    }

    // Not anchored to the start of the message - real messages are
    // prefixed with "Dear Customer, " (and use "Instructions", plural).
    if (/we have activated standing instructions?/i.test(low)) {
      const mPayee = /Merchant:\s*(.+?),/i.exec(t);
      const rawPayee = mPayee ? mPayee[1].trim() : null;
      const mAmt = new RegExp(AMOUNT_RE, "i").exec(t);
      return result({
        type: "ignored", paymentMethod: "mandate", status: "success",
        accountType: low.includes("debit card") ? "savings" : "credit_card",
        cardOrAccount: card,
        payee: cleanPayee(rawPayee), note: rawPayee,
        amount: mAmt ? parseAmount(mAmt[1]) : null,
        currency: mAmt ? detectCurrency(t, mAmt.index + mAmt[0].indexOf(mAmt[1])) : "INR",
      });
    }

    if (low.includes("is due by") || low.includes("due by")) {
      const mAmt = new RegExp(AMOUNT_RE, "i").exec(t);
      const mPayee = /(?:for|towards Merchant)\s+(.+?)(?:\s+to be debited|,\s*as per)/i.exec(t);
      const rawPayee = mPayee ? mPayee[1].trim() : null;
      const mDate = /due by\s+(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(t);
      return result({
        type: "ignored", paymentMethod: "mandate", status: "pending",
        accountType: "credit_card", cardOrAccount: card,
        payee: cleanPayee(rawPayee), note: rawPayee,
        amount: mAmt ? parseAmount(mAmt[1]) : null,
        currency: mAmt ? detectCurrency(t, mAmt.index + mAmt[0].indexOf(mAmt[1])) : "INR",
        transactionDate: mDate ? parseDateSlash(mDate[1]) : null,
      });
    }

    // Fall through to needs_review if a Standing Instruction message doesn't
    // match any known sub-state - deliberately not guessed at.
  }

  // ================= 16. Declined transactions -> debit/failed =================
  m = new RegExp(
    String.raw`(?:Your\s+)?[Tt]ransaction of\s+${AMOUNT_RE}(?:\s+at\s+(.+?))?\s+on ICICI Bank Credit Card\s*${ACCT_RE}\s+(?:is|was)\s+(?:declined|withheld for security reasons)`,
    "i"
  ).exec(t);
  if (m) {
    const rawPayee = m[2] ? m[2].trim() : null;
    return result({
      type: "debit", paymentMethod: "card", status: "failed",
      accountType: "credit_card", cardOrAccount: m[3],
      payee: cleanPayee(rawPayee), note: rawPayee,
      amount: parseAmount(m[1]), currency: detectCurrency(t, m.index + m[0].indexOf(m[1])),
    });
  }

  // ================= 17. Auto-debit could not be completed -> ignored/failed =================
  if (low.includes("auto-debit") && low.includes("could not be completed")) {
    const mCard = new RegExp(CARD_RE, "i").exec(t);
    return result({
      type: "ignored", paymentMethod: "mandate", status: "failed",
      accountType: "credit_card", cardOrAccount: mCard ? mCard[1] : null,
    });
  }

  // ================= 18. ECS/NACH returned -> ignored/failed =================
  if (low.includes("ecs/nach") && low.includes("has returned")) {
    const mAmt = new RegExp(AMOUNT_RE, "i").exec(t);
    const mPayee = /towards\s+(.+?)\s+from/i.exec(t);
    const rawPayee = mPayee ? mPayee[1].trim() : null;
    return result({
      type: "ignored", paymentMethod: "ach", status: "failed",
      accountType: "savings", note: rawPayee,
      amount: mAmt ? parseAmount(mAmt[1]) : null,
    });
  }

  // ================= 19. Refund credited to card =================
  m = new RegExp(
    String.raw`^(.+?)\s+refund of\s+${AMOUNT_RE}\s+credited to ICICI Bank Credit Card\s*${ACCT_RE}\s+on\s+${DATE_RE}`,
    "i"
  ).exec(t);
  if (m) {
    return result({
      type: "credit", paymentMethod: "card", status: "success",
      accountType: "credit_card", cardOrAccount: m[3],
      payee: cleanPayee(m[1].trim()), note: m[1].trim(),
      amount: parseAmount(m[2]), currency: detectCurrency(t, m.index + m[0].indexOf(m[2])),
      transactionDate: parseDate(m[4]),
    });
  }

  // ================= 19b. Card-side transaction reversal ("...has been reversed") =================
  m = new RegExp(
    String.raw`transaction of\s+${AMOUNT_RE}\s+on ICICI Bank Credit Card\s*${ACCT_RE}\s+at\s+(.+?)\s+dated\s+${DATE_RE}.*?has been reversed`,
    "i"
  ).exec(t);
  if (m) {
    return result({
      type: "credit", paymentMethod: "card", status: "success",
      accountType: "credit_card", cardOrAccount: m[2],
      payee: cleanPayee(m[3].trim()), note: m[3].trim(),
      amount: parseAmount(m[1]), currency: detectCurrency(t, m.index + m[0].indexOf(m[1])),
      transactionDate: parseDate(m[4]),
    });
  }

  // ================= 19c. Mutual fund redemption payout credited via NEFT =================
  m = new RegExp(
    String.raw`Redemption payout of Rs\.?([\d,]+\.?\d*)\s+for trade date\s+\d{1,2}\/\d{1,2}\/\d{4}\s+under\s+Folio-\S+\s+in\s+(.+?)\s+is initiated through NEFT.*?on\s+(\d{1,2}\/\d{1,2}\/\d{4})`,
    "i"
  ).exec(t);
  if (m) {
    return result({
      type: "credit", paymentMethod: "neft", status: "success",
      accountType: "savings", isTransfer: false,
      payee: cleanPayee(m[2].trim()), note: m[2].trim(),
      amount: parseAmount(m[1]), currency: "INR",
      transactionDate: parseDateSlash(m[3]),
    });
  }

  // ================= 20. Reversal credited to account =================
  m = new RegExp(
    String.raw`Account\s*${ACCT_RE}\s+has been credited with\s+${AMOUNT_RE}\s+on\s+${DATE_RE}\s+as reversal of transaction with UPI:\s*(\d+)`,
    "i"
  ).exec(t);
  if (m) {
    return result({
      type: "credit", paymentMethod: "upi", status: "success",
      accountType: "savings", cardOrAccount: m[1],
      payee: null, note: `reversal, UPI ref ${m[4]}`,
      amount: parseAmount(m[2]), currency: detectCurrency(t, m.index + m[0].indexOf(m[2])),
      transactionDate: parseDate(m[3]),
    });
  }

  // ================= 21. CC -> Savings refund transfer (duplicate) -> ignored =================
  if (
    low.includes("refund of") &&
    low.includes("from icici bank credit card") &&
    low.includes("to savings account") &&
    low.includes("successfully transferred")
  ) {
    return result({ type: "ignored", paymentMethod: "card" });
  }

  // ================= 22. NEFT/RTGS beneficiary-credited (outgoing, duplicate) -> ignored =================
  if (/(?:neft|rtgs) transaction with reference number/i.test(low) && low.includes("credited to the beneficiary account")) {
    return result({ type: "ignored", paymentMethod: "neft" });
  }

  // ================= 23. CC bill due/generated/received family -> ignored =================
  if (low.includes("total amount due on icici bank credit card")) {
    return result({ type: "ignored", paymentMethod: "card" });
  }
  if (/total amount of .* is due on icici bank credit card/i.test(low)) {
    return result({ type: "ignored", paymentMethod: "card" });
  }
  if (low.includes("has been received on your icici bank credit card")) {
    return result({ type: "ignored", paymentMethod: "card" });
  }
  if (low.includes("credit card bill for icici bank") && low.includes("has been generated")) {
    return result({ type: "ignored", paymentMethod: "card" });
  }
  if (low.includes("minimum amount due calculation")) {
    return result({ type: "ignored", paymentMethod: "card" });
  }
  // Several other "total due / min due by DATE" wordings exist:
  // "Total Due INR X & Min Due INR Y to be paid by...", "Kindly pay total
  // due of Rs X or Min Due Rs Y by...", "Pay Total Due of Rs X or Minimum
  // Due Rs Y by... for ICICI Bank Credit Card...".
  if (
    low.includes("total due") &&
    (low.includes("min due") || low.includes("minimum due")) &&
    low.includes("credit card")
  ) {
    return result({ type: "ignored", paymentMethod: "card" });
  }

  // ================= 24. Fraud-check / unable to confirm -> ignored =================
  if (low.includes("unable to confirm") || (low.includes("unable to reach you") && low.includes("confirm"))) {
    return result({ type: "ignored", paymentMethod: "unknown" });
  }

  // ================= 24b. UPI Autopay mandate lifecycle notices -> ignored =================
  // Different terminology family than "Standing Instruction" - mandate
  // creation/approval/hold notices, not the actual charge itself.
  if (low.includes("mandate") && low.includes("raised by") && low.includes("for your approval")) {
    return result({ type: "ignored", paymentMethod: "mandate" });
  }
  if (low.includes("you have approved the mandate")) {
    return result({ type: "ignored", paymentMethod: "mandate" });
  }
  if (low.includes("account has been blocked") && low.includes("mandate")) {
    return result({ type: "ignored", paymentMethod: "mandate" });
  }

  // ================= 25. iMobile / security / account-settings notices -> ignored =================
  const INFO_MARKERS = [
    "incorrect password detected",
    "transaction safety and security alert",
    "we have applied usage settings",
    "registration for icici bank imobile",
    "you have changed your device for upi",
    "congratulations on activating icici bank imobile",
    "is blocked for 3d secure",
    "has been successfully unblocked for 3d secure",
    "you have enabled biometric authentication",
    "current credit limit on your icici bank credit card is the same",
    "icici bank imobile has been reactivated",
    "access to imobile, fund transfer blocked",
    "revised dynamic currency conversion fee",
    "the credit limit for your icici bank credit card",
    "we have changed the spend limit",
    "relationship manager",
    "important update regarding",
    "esign document has been successfully signed",
    "we have registered your request for debit card",
    "dispatched: card-", "out for delivery: card-", "delivered: card-",
    "thank you for banking with icici bank",
    "we have activated your auto debit facility request",
  ];
  if (INFO_MARKERS.some((marker) => low.includes(marker))) {
    return result({ type: "ignored", paymentMethod: "unknown" });
  }
  // Payee name can be more than one word ("Payee Goa Villa added.").
  if (/^payee\s+.+?\s+added/i.test(low) || low.includes("have passed since adding")) {
    return result({ type: "ignored", paymentMethod: "unknown" });
  }

  // ================= 26. Promotional messages -> ignored =================
  const PROMO_MARKERS = [
    "congrats! you can increase the limit", "personal loan", "home loan",
    "pre-approved", "joining fee", "upgrade to icici bank",
    "avail lifetime free icici bank", "flexicash", "salary overdraft",
    "zodiac sign", "flaunt your favourite picture", "lounge access",
    "credit limit increase on your icici bank credit card",
    "convert your icici bank credit card transactions into emis",
    "in 30 sec",
    "icici bank paylater", "duty-free shopping", "festival of electronics",
    "times group patron",
  ];
  if (PROMO_MARKERS.some((marker) => low.includes(marker))) {
    return result({ type: "ignored", paymentMethod: "unknown" });
  }

  // ================= 27. Other pre-existing informational patterns -> ignored =================
  if (/\botp\b/i.test(low) || low.includes("one-time password")) {
    return result({ type: "ignored", paymentMethod: "unknown", note: t || null });
  }
  if (low.includes("statement is sent to")) {
    return result({ type: "ignored", paymentMethod: "unknown", note: t || null });
  }
  if (/update kyc/i.test(low)) {
    return result({ type: "ignored", paymentMethod: "unknown", note: t || null });
  }
  if (low.includes("trying to reach you")) {
    return result({ type: "ignored", paymentMethod: "unknown", note: t || null });
  }
  if (low.includes("account has been unblocked")) {
    return result({ type: "ignored", paymentMethod: "unknown", note: t || null });
  }
  if (low.includes("bharat bill payment system")) {
    return result({ type: "ignored", paymentMethod: "card", note: t || null });
  }

  // ================= fallback: matches neither a known transaction shape nor a =================
  // ================= known non-transaction pattern =================
  return result({
    type: "needs_review", paymentMethod: "unknown", status: null,
    accountType: "unknown", isTransfer: false, cardOrAccount: null,
    payee: null, note: t || null, amount: null, currency: "INR",
    transactionDate: null,
  });
}
