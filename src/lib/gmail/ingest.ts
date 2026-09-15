/**
 * Turning a staged Gmail alert into a transaction, or deciding not to.
 *
 * This is the single copy of that decision. The 24-month backfill script and the
 * 15-minute poller both import it, because the moment they each own a version of
 * "is this already captured" the two will disagree and the disagreement will be
 * a duplicate charge in someone's spend.
 *
 * The two differ in exactly one policy, passed in rather than branched on here:
 * the backfill holds NO MATCH rows for a human, the poller ingests them. Both
 * flag every row they create for review.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
// Relative, not the "@/" alias, because scripts/ingest_email_staging.mjs imports
// this file directly through node's TypeScript support, which does not read
// tsconfig path aliases. Sharing the logic with the backfill matters more than
// matching the import style of files only Next.js ever loads.
import { payeeKey } from "../payeeKey.ts";

export const TEN_MINUTES_MS = 10 * 60 * 1000;

export const istDate = (ms: number | string): string =>
  new Date(Number(ms)).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const UPI_REF = /UPI[-:\s]*(\d{9,})/i;
export const upiRef = (s: string | null | undefined): string | null => String(s ?? "").match(UPI_REF)?.[1] ?? null;

/** "UPI-662216952359-LOCO BEA" -> "LOCO BEA". */
export const stripUpiRef = (s: string | null | undefined): string =>
  String(s ?? "").replace(/^UPI[-:\s]*\d+[-\s]*/i, "").trim();

/**
 * The merchant_categories key for an email-sourced merchant.
 *
 * Truncated to the 15 characters the SMS would have carried so one merchant
 * keeps one key across both channels. Keying on the full email string instead
 * was measured on this mailbox: 60 distinct new keys rather than 5, with Swiggy
 * split across six of them and five per-charge "CANVA* I04741-53337637" keys
 * that can never be hit twice.
 */
export const emailCacheKey = (payeeEmail: string): string =>
  payeeKey(stripUpiRef(payeeEmail).slice(0, 15).trim());

/** What the merchant list shows: never a bare reference number. */
export const displayPayee = (payeeEmail: string): string => stripUpiRef(payeeEmail) || payeeEmail;

/**
 * Two payee strings describe the same merchant.
 *
 * Prefix comparison runs BOTH ways. The SMS truncates at 15 characters, but
 * payeeKey also strips legal suffixes, so "BOOK MY FOREX PVT LTD" normalises
 * SHORTER ("book my forex") than the truncated SMS stump ("book my forex p").
 * Testing one direction only reported 84 false "no match" results against the
 * 10 that survived both directions plus a 4-character floor.
 *
 * Exact string equality was the alternative and is far worse here: it misses
 * 621 of 909 real pairs, a third of them on casing alone.
 */
export function sameMerchant(emailRaw: string, smsRaw: string | null): boolean {
  if (!smsRaw) return false;
  const sms = payeeKey(smsRaw);
  if (!sms) return false;
  for (const candidate of [payeeKey(emailRaw), payeeKey(stripUpiRef(emailRaw))]) {
    if (!candidate) continue;
    if (candidate === sms) return true;
    const [short, long] = candidate.length <= sms.length ? [candidate, sms] : [sms, candidate];
    if (short.length >= 4 && long.startsWith(short)) return true;
  }
  return false;
}

export interface TransactionRow {
  id: number;
  payee: string | null;
  note: string | null;
  amount: number | null;
  card_or_account: string | null;
  transaction_date: string | null;
  gmail_message_id: string | null;
  raw_messages?: { phone_received_at: string | null } | null;
}

export interface StagedRow {
  gmail_message_id: string;
  internal_date: number | string;
  status: string;
  amount: number | null;
  card_last4: string | null;
  payee_email: string | null;
  raw_body: string | null;
}

export interface TransactionIndexes {
  byReference: Map<string, TransactionRow[]>;
  byFingerprint: Map<string, TransactionRow[]>;
  ingestedGmailIds: Set<string>;
}

export function buildTransactionIndexes(rows: TransactionRow[]): TransactionIndexes {
  const byReference = new Map<string, TransactionRow[]>();
  const byFingerprint = new Map<string, TransactionRow[]>();
  const ingestedGmailIds = new Set<string>();
  for (const t of rows) {
    if (t.gmail_message_id) ingestedGmailIds.add(t.gmail_message_id);
    const ref = upiRef(t.note) ?? upiRef(t.payee);
    if (ref) {
      if (!byReference.has(ref)) byReference.set(ref, []);
      byReference.get(ref)!.push(t);
    }
    if (t.amount != null && t.card_or_account && t.transaction_date) {
      const key = `${t.card_or_account}|${Number(t.amount)}|${t.transaction_date}`;
      if (!byFingerprint.has(key)) byFingerprint.set(key, []);
      byFingerprint.get(key)!.push(t);
    }
  }
  return { byReference, byFingerprint, ingestedGmailIds };
}

export type Verdict =
  | { kind: "already-ingested"; transactionId?: number; why: string }
  | { kind: "duplicate"; transactionId: number; why: string }
  | { kind: "ambiguous"; candidateIds: number[]; why: string }
  | { kind: "no-match" };

/**
 * Has this charge already been captured?
 *
 * Three keys in descending order of how much they prove. The bank's reference
 * identifies one movement of money. The fingerprint (card, amount, IST date)
 * plus a merchant comparison identifies a charge the SMS described differently.
 * More than one candidate means ambiguity, and ambiguity is left alone - of the
 * 20 ambiguous cases in this mailbox, every one was two alerts against two
 * genuine same-day same-amount charges, which nothing here can pair up.
 */
export function classifyAgainstTransactions(row: StagedRow, ix: TransactionIndexes): Verdict {
  if (ix.ingestedGmailIds.has(row.gmail_message_id)) {
    return { kind: "already-ingested", why: "a transaction already cites this gmail_message_id" };
  }
  const reference = upiRef(row.payee_email);
  let refHits = reference ? ix.byReference.get(reference) ?? [] : [];
  // The SMS truncates the reference mid-digit, so the stored stump is a prefix
  // of the email's full reference rather than equal to it.
  if (reference && refHits.length === 0) {
    for (const [stored, rows] of ix.byReference) {
      if (stored.length >= 9 && reference.startsWith(stored)) refHits = refHits.concat(rows);
    }
  }
  if (refHits.length === 1) {
    return { kind: "duplicate", transactionId: refHits[0].id, why: `bank reference ${reference}` };
  }
  if (refHits.length > 1) {
    return { kind: "ambiguous", candidateIds: refHits.map((t) => t.id), why: "reference matches more than one transaction" };
  }

  const fingerprint = `XX${row.card_last4}|${Number(row.amount)}|${istDate(row.internal_date)}`;
  const candidates = (ix.byFingerprint.get(fingerprint) ?? []).filter(
    (t) => sameMerchant(row.payee_email ?? "", t.payee) || sameMerchant(row.payee_email ?? "", t.note)
  );
  if (candidates.length > 1) {
    return { kind: "ambiguous", candidateIds: candidates.map((t) => t.id), why: "card, amount, date and merchant match more than one transaction" };
  }
  if (candidates.length === 1) {
    const smsAt = candidates[0].raw_messages?.phone_received_at
      ? Date.parse(candidates[0].raw_messages.phone_received_at!)
      : null;
    const delta = smsAt == null ? null : Math.abs(Number(row.internal_date) - smsAt);
    return {
      kind: "duplicate",
      transactionId: candidates[0].id,
      why: delta != null && delta <= TEN_MINUTES_MS ? "fingerprint, within 10 minutes" : "fingerprint, with a time gap",
    };
  }
  return { kind: "no-match" };
}

export interface EmailInsertPlan {
  gmail_message_id: string;
  internal_date: number;
  amount: number;
  transaction_date: string;
  card_or_account: string;
  payee: string;
  payee_email: string;
  key: string;
  keyExists: boolean;
  category_id: number | null;
  confidence_source: string | null;
  payment_method: "upi" | "card";
  raw_body: string;
}

/**
 * The row an email would become.
 *
 * The category comes from merchant_categories or it does not come at all - no
 * model call, here or anywhere downstream of here. A key nobody has seen lands
 * uncategorized and flagged, which is a question for a person rather than a
 * guess presented as an answer.
 */
export function planInsert(
  row: StagedRow,
  cache: Map<string, { category_id: number | null; confidence_source: string | null }>
): EmailInsertPlan {
  const payeeEmail = row.payee_email ?? "";
  const key = emailCacheKey(payeeEmail);
  const hit = cache.get(key);
  return {
    gmail_message_id: row.gmail_message_id,
    internal_date: Number(row.internal_date),
    amount: Number(row.amount),
    transaction_date: istDate(row.internal_date),
    card_or_account: `XX${row.card_last4}`,
    payee: displayPayee(payeeEmail),
    payee_email: payeeEmail,
    key,
    keyExists: !!hit,
    category_id: hit?.category_id ?? null,
    confidence_source: hit?.confidence_source ?? null,
    payment_method: /^UPI[-:\s]*\d/i.test(payeeEmail) ? "upi" : "card",
    raw_body: row.raw_body ?? "",
  };
}

/**
 * Writes the raw_messages row and then the transaction.
 *
 * raw_messages first because transactions.raw_message_id is NOT NULL and that
 * row is where capture_source lives. If the transaction insert fails - most
 * likely on the gmail_message_id unique index, which is the backstop under every
 * check above - the raw_messages row is removed again rather than left as an
 * email body nothing points at.
 */
export async function insertEmailTransaction(
  sb: SupabaseClient,
  plan: EmailInsertPlan
): Promise<{ transactionId: number; rawMessageId: number } | { error: string }> {
  const { data: rawMessage, error: rawError } = await sb
    .from("raw_messages")
    .insert({
      message: plan.raw_body,
      phone_received_at: new Date(plan.internal_date).toISOString(),
      capture_source: "email",
    })
    .select("id")
    .single();
  if (rawError || !rawMessage) return { error: `raw_messages: ${rawError?.message ?? "no row returned"}` };

  const { data: transaction, error: txError } = await sb
    .from("transactions")
    .insert({
      raw_message_id: rawMessage.id,
      gmail_message_id: plan.gmail_message_id,
      type: "debit",
      payment_method: plan.payment_method,
      status: "success",
      account_type: "credit_card",
      is_transfer: false,
      card_or_account: plan.card_or_account,
      payee: plan.payee,
      payee_email: plan.payee_email,
      note: plan.payee_email,
      amount: plan.amount,
      currency: "INR",
      transaction_date: plan.transaction_date,
      category_id: plan.category_id,
      needs_category_review: true,
    })
    .select("id")
    .single();

  if (txError || !transaction) {
    await sb.from("raw_messages").delete().eq("id", rawMessage.id);
    return { error: `transactions: ${txError?.message ?? "no row returned"}` };
  }
  return { transactionId: transaction.id, rawMessageId: rawMessage.id };
}
