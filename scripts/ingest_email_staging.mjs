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
import {
  buildTransactionIndexes,
  classifyAgainstTransactions,
  insertEmailTransaction,
  planInsert,
  istDate,
} from "../src/lib/gmail/ingest.ts";

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

console.log(`${APPLY ? "APPLYING" : "DRY RUN - nothing will be written"}`);
console.log(`  transactions in table            : ${txns.length}`);
console.log(`  gmail_staging rows               : ${staged.length}`);
console.log(`  quarantined, never considered    : ${quarantined.length}`);
console.log(`  success rows eligible for review : ${success.length}`);

// The same indexes and the same verdicts the poller uses. Shared on purpose: two
// copies of "is this already captured" would eventually disagree, and the
// disagreement would be a double-counted charge.
const indexes = buildTransactionIndexes(txns);
console.log(`  already ingested from email      : ${indexes.ingestedGmailIds.size}\n`);

const matched = [], ambiguous = [], noMatch = [];
for (const r of success) {
  const verdict = classifyAgainstTransactions(r, indexes);
  if (verdict.kind === "ambiguous") ambiguous.push({ r, verdict });
  else if (verdict.kind === "no-match") noMatch.push({ r });
  else matched.push({ r, verdict });
}

console.log(`  already captured over SMS        : ${matched.length}`);
console.log(`  ambiguous, left alone            : ${ambiguous.length}`);
console.log(`  NO MATCH - candidates for insert : ${noMatch.length}\n`);

// Every row this run would create. Flagged for review without exception: an
// alert with no SMS twin is the one case nothing else has corroborated, so it
// gets a person's eyes before it counts as settled spend.
const plan = noMatch.map(({ r }) => planInsert(r, cacheByKey));

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
  const result = await insertEmailTransaction(sb, p);
  if ("error" in result) { console.error(`  FAILED ${p.gmail_message_id}: ${result.error}`); continue; }
  console.log(`  inserted txn ${result.transactionId}  raw_message ${result.rawMessageId}  INR ${p.amount}  ${p.payee}`);
  inserted++;
}
console.log(`\ninserted: ${inserted} of ${selected.length}`);
