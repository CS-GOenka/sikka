#!/usr/bin/env node
// Ingests parsed Gmail alerts from gmail_staging into transactions.
//
//   node scripts/ingest_email_staging.mjs            # dry run - writes nothing
//   node scripts/ingest_email_staging.mjs --apply    # writes
//
// Manual trigger only. Nothing schedules this, on purpose: the SMS pipeline is
// still the primary channel and this is the backstop for what it missed, so a
// human decides when the backstop runs.
//
// It makes no model calls. Categories come from merchant_categories or they do
// not come at all - a row whose key is unknown lands uncategorized and flagged,
// where a person can answer it. That is the whole reason the 13 inherited keys
// were seeded first: the alternative to a cache hit here is not a guess, it is
// a review queue.
//
// WHAT IT WILL NOT TOUCH
//
//   - quarantined staging rows (45: bill payments, non-INR, declined). They are
//     not purchases, and their financial fields are null by design.
//   - any charge the SMS pipeline already captured. Matching is the same logic
//     the diff used: the bank's reference first, then card+amount+IST-date with
//     the bidirectional-prefix merchant comparator.
//   - any alert already ingested, checked on gmail_message_id. The unique index
//     on that column is the hard backstop underneath this check: if the reader
//     and the index ever disagree, the index wins and the insert fails loudly.
//
// KEYING
//
// The cache key is the email merchant truncated to the 15 characters the SMS
// would have carried, after stripping a "UPI-<ref>-" prefix. Keying on the full
// email string instead fragments the cache badly - measured against this
// mailbox, 60 distinct new keys rather than 5, with Swiggy split across six of
// them.
//
// Three fields, three jobs. payee_email holds exactly what the bank wrote. payee
// holds the display name - payee_email with any "UPI-<ref>-" prefix stripped,
// because a one-time reference number is not a merchant and must never show up
// in a list of places money went. The cache key is the truncation.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import { payeeKey } from "../src/lib/payeeKey.ts";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--apply");
// --only=<gmail_message_id>[,...] restricts the run. A 24-month backfill is not
// one decision: the September rows were corroborated by chat.db, the older ones
// by an available-limit chain, and those were approved separately.
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").map((x) => x.trim()).filter(Boolean)) : null;

const TEN_MIN = 10 * 60 * 1000;
const istDate = (ms) => new Date(Number(ms)).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const upiRef = (s) => String(s ?? "").match(/UPI[-:\s]*(\d{9,})/i)?.[1] ?? null;
const stripUpi = (s) => String(s ?? "").replace(/^UPI[-:\s]*\d+[-\s]*/i, "").trim();

/**
 * Two payee strings describe the same merchant.
 *
 * Prefix comparison runs BOTH ways. The SMS truncates at 15 characters, but
 * payeeKey also strips legal suffixes, so "BOOK MY FOREX PVT LTD" normalises
 * SHORTER ("book my forex") than the truncated SMS stump ("book my forex p").
 * Testing one direction only missed every merchant whose name is long enough to
 * be cut but ends in a suffix the normalizer removes - 84 false "no match"
 * results, against 10 once both directions and a 4-character floor were used.
 */
function sameMerchant(emailRaw, smsRaw) {
  if (!smsRaw) return false;
  const sms = payeeKey(smsRaw);
  if (!sms) return false;
  for (const e of [payeeKey(emailRaw), payeeKey(stripUpi(emailRaw))]) {
    if (!e) continue;
    if (e === sms) return true;
    const [short, long] = e.length <= sms.length ? [e, sms] : [sms, e];
    if (short.length >= 4 && long.startsWith(short)) return true;
  }
  return false;
}

/** The key merchant_categories is looked up on: the SMS-shaped form. */
const cacheKeyFor = (payeeEmail) => payeeKey(stripUpi(payeeEmail).slice(0, 15).trim());

async function selectAll(table, columns, refine = (q) => q) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await refine(sb.from(table).select(columns)).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

const staged = await selectAll("gmail_staging", "gmail_message_id, internal_date, status, amount, card_last4, payee_email, raw_body, quarantine_reason");
const txns = await selectAll("transactions", "id, payee, note, amount, card_or_account, transaction_date, gmail_message_id, raw_messages(phone_received_at)");
const cache = await selectAll("merchant_categories", "payee, category_id, confidence_source");
const cats = await selectAll("categories", "id, name");
const catName = (id) => cats.find((c) => c.id === id)?.name ?? "none";
const cacheByKey = new Map(cache.map((r) => [r.payee, r]));

const success = staged.filter((r) => r.status === "success");
const quarantined = staged.filter((r) => r.status !== "success");
const alreadyIngested = new Set(txns.map((t) => t.gmail_message_id).filter(Boolean));

console.log(`${APPLY ? "APPLYING" : "DRY RUN - nothing will be written"}`);
console.log(`  transactions in table            : ${txns.length}`);
console.log(`  gmail_staging rows               : ${staged.length}`);
console.log(`  quarantined, never considered    : ${quarantined.length}`);
console.log(`  success rows eligible for review : ${success.length}`);
console.log(`  already ingested from email      : ${alreadyIngested.size}\n`);

// Index the stored transactions the same two ways the diff did.
const byRef = new Map(), byFp = new Map();
for (const t of txns) {
  const r = upiRef(t.note) ?? upiRef(t.payee);
  if (r) { if (!byRef.has(r)) byRef.set(r, []); byRef.get(r).push(t); }
  if (t.amount != null && t.card_or_account && t.transaction_date) {
    const k = `${t.card_or_account}|${Number(t.amount)}|${t.transaction_date}`;
    if (!byFp.has(k)) byFp.set(k, []); byFp.get(k).push(t);
  }
}

const matched = [], ambiguous = [], noMatch = [];
for (const r of success) {
  if (alreadyIngested.has(r.gmail_message_id)) { matched.push({ r, why: "already ingested from email" }); continue; }
  const card = `XX${r.card_last4}`, day = istDate(r.internal_date);
  const ref = upiRef(r.payee_email);
  let refHits = ref ? (byRef.get(ref) ?? []) : [];
  if (ref && refHits.length === 0) {
    for (const [k, v] of byRef) if (k.length >= 9 && ref.startsWith(k)) refHits = refHits.concat(v);
  }
  if (refHits.length === 1) { matched.push({ r, t: refHits[0], why: `reference ${ref}` }); continue; }
  if (refHits.length > 1) { ambiguous.push({ r, cands: refHits, why: "reference matches >1" }); continue; }

  const cands = (byFp.get(`${card}|${r.amount}|${day}`) ?? [])
    .filter((t) => sameMerchant(r.payee_email, t.payee) || sameMerchant(r.payee_email, t.note));
  if (cands.length > 1) { ambiguous.push({ r, cands, why: "card+amount+date+merchant matches >1" }); continue; }
  if (cands.length === 1) {
    const sms = cands[0].raw_messages?.phone_received_at ? Date.parse(cands[0].raw_messages.phone_received_at) : null;
    const delta = sms == null ? null : Math.abs(Number(r.internal_date) - sms);
    matched.push({ r, t: cands[0], why: delta != null && delta <= TEN_MIN ? "fingerprint, within 10 min" : "fingerprint, time gap" });
    continue;
  }
  noMatch.push({ r });
}

console.log(`  already captured over SMS        : ${matched.length}`);
console.log(`  ambiguous, left alone            : ${ambiguous.length}`);
console.log(`  NO MATCH - candidates for insert : ${noMatch.length}\n`);

// Every row this run would create. Flagged for review without exception: an
// alert with no SMS twin is the one case nothing else has corroborated, so it
// gets a person's eyes before it counts as settled spend.
const plan = noMatch.map(({ r }) => {
  const key = cacheKeyFor(r.payee_email);
  const hit = cacheByKey.get(key);
  return {
    gmail_message_id: r.gmail_message_id,
    internal_date: Number(r.internal_date),
    amount: Number(r.amount),
    transaction_date: istDate(r.internal_date),
    card_or_account: `XX${r.card_last4}`,
    payee_email: r.payee_email,
    // stripUpi turns "UPI-662216952359-LOCO BEA" into "LOCO BEA"; a bare
    // reference would otherwise become a merchant-list entry of its own.
    payee: stripUpi(r.payee_email) || r.payee_email,
    key,
    keyExists: !!hit,
    category_id: hit?.category_id ?? null,
    confidence_source: hit?.confidence_source ?? null,
    payment_method: /^UPI[-:\s]*\d/i.test(r.payee_email) ? "upi" : "card",
    raw_body: r.raw_body,
  };
});

const selected = ONLY ? plan.filter((p) => ONLY.has(p.gmail_message_id)) : plan;
if (ONLY) {
  const missing = [...ONLY].filter((id) => !plan.some((p) => p.gmail_message_id === id));
  console.log(`--only: ${selected.length} of ${plan.length} candidates selected` +
    (missing.length ? `; ${missing.length} requested id(s) are not candidates: ${missing.join(", ")}` : ""));
  const held = plan.filter((p) => !ONLY.has(p.gmail_message_id));
  if (held.length) {
    console.log(`held back (${held.length}):`);
    for (const p of held) console.log(`    ${p.transaction_date}  INR ${String(p.amount).padStart(9)}  ${p.payee}`);
  }
  console.log();
}

console.log("=== WOULD INSERT ===");
if (!selected.length) console.log("  (nothing)");
for (const p of selected) {
  console.log(`  ${p.transaction_date}  ${p.card_or_account}  INR ${String(p.amount).padStart(9)}  payee ${JSON.stringify(p.payee)}`);
  console.log(`      payee_email ${JSON.stringify(p.payee_email)}`);
  console.log(`      key ${JSON.stringify(p.key).padEnd(26)} in cache: ${p.keyExists ? `YES -> ${catName(p.category_id)} (${p.category_id}) [${p.confidence_source}]` : "NO  -> uncategorized"}`);
  console.log(`      method ${p.payment_method}   needs_category_review: true   gmail_message_id ${p.gmail_message_id}`);
}
console.log(`\nLLM calls made: 0 (this script cannot make one - it never imports the model client)`);

if (!APPLY) {
  console.log(`\nDRY RUN - rows written: 0`);
  process.exit(0);
}

let inserted = 0;
for (const p of selected) {
  // raw_messages first: transactions.raw_message_id is NOT NULL, and this row
  // is where capture_source lives. The stored message is the email body, which
  // is the actual text this transaction was read out of.
  const { data: rm, error: rmErr } = await sb.from("raw_messages").insert({
    message: p.raw_body,
    phone_received_at: new Date(p.internal_date).toISOString(),
    capture_source: "email",
  }).select("id").single();
  if (rmErr || !rm) { console.error(`  FAILED raw_messages for ${p.gmail_message_id}: ${rmErr?.message}`); continue; }

  const { data: tx, error: txErr } = await sb.from("transactions").insert({
    raw_message_id: rm.id,
    gmail_message_id: p.gmail_message_id,
    type: "debit",
    payment_method: p.payment_method,
    status: "success",
    account_type: "credit_card",
    is_transfer: false,
    card_or_account: p.card_or_account,
    payee: p.payee,
    payee_email: p.payee_email,
    note: p.payee_email,
    amount: p.amount,
    currency: "INR",
    transaction_date: p.transaction_date,
    category_id: p.category_id,
    needs_category_review: true,
  }).select("id").single();
  if (txErr || !tx) {
    console.error(`  FAILED transactions for ${p.gmail_message_id}: ${txErr?.message}`);
    // Leave no orphan behind: without a transaction the raw_messages row is
    // just an email body nothing points at.
    await sb.from("raw_messages").delete().eq("id", rm.id);
    continue;
  }
  console.log(`  inserted txn ${tx.id}  raw_message ${rm.id}  INR ${p.amount}  ${p.payee}`);
  inserted++;
}
console.log(`\ninserted: ${inserted} of ${selected.length}`);
