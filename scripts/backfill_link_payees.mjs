#!/usr/bin/env node
// Repairs transactions whose payee is a tracking link rather than a merchant
// name - the bug fixed in cleanPayee() (src/lib/classify.ts).
//
//   node scripts/backfill_link_payees.mjs            # dry run - shows what it would do
//   node scripts/backfill_link_payees.mjs --apply    # writes
//
// The parser fix only stops NEW links from being stored. Rows already written
// keep their link, and worse, keep the merchant_categories entry the link
// taught - a key that can never be hit again but still occupies the cache.
//
// The real merchant is recovered from gmail_staging where the email alert for
// the same charge exists: the emails carry the full merchant name, which is
// exactly what the SMS dropped. Matched on amount + card + IST calendar date,
// and only when that match is unique - a name guessed from an ambiguous match
// would be worse than the link it replaced, because it would look correct.
//
// Safe to re-run: a repaired row no longer has a link payee and is not selected.
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

// Kept in step with LINK_NOT_MERCHANT_RE in src/lib/classify.ts.
const isLink = (p) => !!p && /^https?:\/\/|^(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S/i.test(p.trim());

// gmail_staging stores internalDate as a UTC epoch. The transaction date is an
// IST calendar day, so compare in IST (+5:30, no DST) rather than in UTC -
// anything charged after 18:30 UTC falls on the next UTC day but the same IST
// one, and 4 of this mailbox's alerts land in that window.
const istDate = (epochMs) => new Date(Number(epochMs) + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

// Paged deliberately. PostgREST caps an unbounded select at 1000 rows and
// says nothing about it, so a plain select here would scan less than a third
// of the table and report a clean bill of health for the rest.
async function selectAll(table, columns, refine = (q) => q) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error: pageError } = await refine(sb.from(table).select(columns)).range(from, from + 999);
    if (pageError) throw pageError;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

const txns = await selectAll("transactions", "id, payee, note, amount, transaction_date, card_or_account, category_id, needs_category_review");

const broken = txns.filter((t) => isLink(t.payee));
console.log(`${APPLY ? "APPLYING" : "DRY RUN"} - ${txns.length} transactions, ${broken.length} with a link as payee\n`);

const staging = await selectAll("gmail_staging", "amount, card_last4, payee_email, internal_date", (q) => q.eq("status", "success"));
const cache = await selectAll("merchant_categories", "payee, category_id");
const cats = await selectAll("categories", "id, name");
const catName = (id) => cats.find((c) => c.id === id)?.name ?? "none";
const cacheHit = (p) => cache.find((c) => c.payee === payeeKey(p));

let repaired = 0, unmatched = 0;
for (const t of broken) {
  const last4 = (t.card_or_account ?? "").replace(/\D/g, "");
  const matches = staging.filter((s) =>
    Number(s.amount) === Number(t.amount) && s.card_last4 === last4 && istDate(s.internal_date) === t.transaction_date);

  if (matches.length !== 1) {
    unmatched++;
    console.log(`  SKIP  id=${t.id} ₹${t.amount} ${t.transaction_date} - ${matches.length} email matches, cannot name it`);
    continue;
  }
  const payee = matches[0].payee_email;
  const hit = cacheHit(payee);
  const update = hit
    ? { payee, category_id: hit.category_id, needs_category_review: false }
    : { payee, category_id: null, needs_category_review: true };

  console.log(`  id=${t.id} ₹${t.amount} ${t.transaction_date}`);
  console.log(`      payee    ${JSON.stringify(t.payee)} -> ${JSON.stringify(payee)}`);
  console.log(`      category ${catName(t.category_id)} -> ${hit ? `${catName(hit.category_id)} (cache hit on "${payeeKey(payee)}")` : "none, flagged for review"}`);

  if (APPLY) {
    const { error: upErr } = await sb.from("transactions").update(update).eq("id", t.id);
    if (upErr) { console.error(`      FAILED: ${upErr.message}`); continue; }
  }
  repaired++;
}

// The cache entries the links taught. Each is keyed on a one-time URL, so it
// can never be hit again - it is pure residue, and it makes the merchant list
// read as though a URL were a place you can spend money.
const junk = cache.filter((c) => isLink(c.payee));
console.log(`\n${junk.length} merchant_categories ${junk.length === 1 ? "entry" : "entries"} keyed on a link:`);
for (const c of junk) console.log(`  ${JSON.stringify(c.payee)} -> ${catName(c.category_id)}`);
if (APPLY && junk.length) {
  const { error: delErr } = await sb.from("merchant_categories").delete().in("payee", junk.map((c) => c.payee));
  if (delErr) console.error(`  FAILED to delete: ${delErr.message}`);
  else console.log(`  deleted`);
}

console.log(`\n${APPLY ? "repaired" : "would repair"}: ${repaired}   unnameable: ${unmatched}`);
