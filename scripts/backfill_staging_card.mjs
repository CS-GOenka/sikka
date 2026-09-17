#!/usr/bin/env node
// Fills card_last4 on gmail_staging rows that were parsed before the masked-PAN
// spelling was recognised.
//
//   node scripts/backfill_staging_card.mjs            # dry run
//   node scripts/backfill_staging_card.mjs --apply    # writes
//
// Only card_last4 is written. Amount, merchant and limit stay exactly as the
// fail-closed parser left them, because nothing here re-decides whether a row is
// a purchase - it only answers which card it was about.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import { cardLast4 } from "../src/lib/gmail/parseCardAlert.ts";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--apply");

const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("gmail_staging")
    .select("gmail_message_id, card_last4, status, quarantine_reason, raw_body").range(from, from + 999);
  if (error) throw error;
  rows.push(...data);
  if (data.length < 1000) break;
}

const missing = rows.filter((r) => !r.card_last4);
console.log(`${APPLY ? "APPLYING" : "DRY RUN"} - ${rows.length} staging rows, ${missing.length} without a card\n`);

const byCard = {}, byReason = {};
let recovered = 0, stillNull = 0;
for (const r of missing) {
  const card = cardLast4(r.raw_body ?? "");
  if (!card) { stillNull++; console.log(`  UNRECOVERABLE  ${r.gmail_message_id}  [${r.quarantine_reason ?? r.status}]`); continue; }
  byCard[card] = (byCard[card] ?? 0) + 1;
  const key = `${r.quarantine_reason ?? r.status} -> XX${card}`;
  byReason[key] = (byReason[key] ?? 0) + 1;
  if (APPLY) {
    const { error } = await sb.from("gmail_staging").update({ card_last4: card }).eq("gmail_message_id", r.gmail_message_id);
    if (error) { console.error(`  FAILED ${r.gmail_message_id}: ${error.message}`); continue; }
  }
  recovered++;
}

console.log(`\nby card:`);
for (const [c, n] of Object.entries(byCard).sort()) console.log(`  XX${c}  ${n}`);
console.log(`\nby reason:`);
for (const [k, n] of Object.entries(byReason).sort()) console.log(`  ${k.padEnd(46)} ${n}`);
console.log(`\n${APPLY ? "recovered" : "would recover"}: ${recovered}   still null: ${stillNull}`);
