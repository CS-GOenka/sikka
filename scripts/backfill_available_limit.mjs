#!/usr/bin/env node
// Fills transactions.available_limit from the text each row was parsed out of.
//
//   node scripts/backfill_available_limit.mjs            # dry run
//   node scripts/backfill_available_limit.mjs --apply    # writes
//
// Two sources, because the two channels word it differently: an SMS says
// "Avl Limit: INR 47,258.57" or "Avl Bal Rs. 4,60,024.28", an email says
// "The Available Credit Limit on your card is INR 1,24,913.27". Email-ingested
// rows take the value gmail_staging already parsed rather than re-reading the
// body, so the stored figure and the staged one can never disagree.
//
// Safe to re-run: a row that already has a value is left alone, so this cannot
// overwrite a figure written at capture time by a newer parse.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import { extractAvailableLimit } from "../src/lib/availableLimit.ts";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--apply");

async function selectAll(table, columns) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

const txns = await selectAll("transactions", "id, account_type, available_limit, gmail_message_id, raw_messages(message)");
const staged = await selectAll("gmail_staging", "gmail_message_id, available_limit");
const stagedLimit = new Map(staged.map((r) => [r.gmail_message_id, r.available_limit]));

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} - ${txns.length} transactions\n`);

const updates = [];
let already = 0, none = 0;
const bySource = { email: 0, sms: 0 };
for (const t of txns) {
  if (t.available_limit != null) { already++; continue; }
  const fromEmail = t.gmail_message_id ? stagedLimit.get(t.gmail_message_id) ?? null : null;
  const limit = fromEmail ?? extractAvailableLimit(t.raw_messages?.message);
  if (limit == null) { none++; continue; }
  bySource[fromEmail != null ? "email" : "sms"]++;
  updates.push({ id: t.id, limit });
}

console.log(`  already have a value        : ${already}`);
console.log(`  would gain one              : ${updates.length}   (from email ${bySource.email}, from SMS ${bySource.sms})`);
console.log(`  alert quotes no figure      : ${none}`);
console.log(`  coverage after              : ${already + updates.length} / ${txns.length} = ${(((already + updates.length) / txns.length) * 100).toFixed(1)}%`);

if (APPLY) {
  let done = 0;
  for (const u of updates) {
    const { error } = await sb.from("transactions").update({ available_limit: u.limit }).eq("id", u.id);
    if (error) { console.error(`  FAILED id=${u.id}: ${error.message}`); continue; }
    done++;
  }
  console.log(`\nwrote: ${done} of ${updates.length}`);
}
