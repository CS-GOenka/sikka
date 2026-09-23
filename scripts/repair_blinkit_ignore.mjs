#!/usr/bin/env node
// Undoes the Blinkit -> Ignore inheritance.
//
//   node scripts/repair_blinkit_ignore.mjs            # dry run
//   node scripts/repair_blinkit_ignore.mjs --apply    # writes
//
// On 15 September 2026 a single Blinkit charge was corrected to Ignore. The
// correction endpoint taught the merchant cache unconditionally, so every
// Blinkit charge since has been filed non-spend without anyone choosing that:
// six transactions, ₹4,973, all of it removed from September's spend silently.
//
// Only the inherited rows move. A transaction that predates the cache row was
// categorised by something else and is left exactly as it is - including txn
// 5085, which has sat in Ignore since 28 August and is not this bug's doing.
//
// The manual cache row is deleted rather than repointed. Repointing it to Quick
// Commerce would replace one unasked-for rule with another; deleting it returns
// Blinkit to being categorised per transaction, which is what the 105
// historical Quick Commerce rows already reflect.
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

const KEY = "blinkit";
const { data: cacheRow } = await sb.from("merchant_categories").select("*").eq("payee", KEY).maybeSingle();
const { data: cats } = await sb.from("categories").select("id, name, counts_as_spend");
const cat = new Map(cats.map((c) => [c.id, c]));
const QUICK_COMMERCE = cats.find((c) => c.name === "Quick Commerce");
if (!QUICK_COMMERCE) throw new Error("Quick Commerce category not found");

console.log(`${APPLY ? "APPLYING" : "DRY RUN"}\n`);
console.log(`cache row: ${cacheRow
  ? `${KEY} -> ${cat.get(cacheRow.category_id)?.name} (${cacheRow.confidence_source}), set ${cacheRow.updated_at}`
  : "(none)"}`);
if (!cacheRow) { console.log("nothing to repair"); process.exit(0); }

const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("transactions")
    .select("id, payee, amount, transaction_date, category_id, created_at, needs_category_review")
    .range(from, from + 999);
  if (error) throw error;
  rows.push(...data);
  if (data.length < 1000) break;
}

const affected = rows.filter((t) =>
  t.payee && payeeKey(t.payee) === KEY &&
  t.category_id === cacheRow.category_id &&
  t.created_at >= cacheRow.updated_at);
const predating = rows.filter((t) =>
  t.payee && payeeKey(t.payee) === KEY &&
  t.category_id === cacheRow.category_id &&
  t.created_at < cacheRow.updated_at);

console.log(`\ninherited into ${cat.get(cacheRow.category_id)?.name} (will move to Quick Commerce): ${affected.length}`);
console.log("  txn    date        amount     payee     created              review");
for (const t of affected.sort((a, b) => a.id - b.id))
  console.log(`  ${String(t.id).padStart(5)}  ${t.transaction_date}  ${String(t.amount).padStart(8)}  ${String(t.payee).padEnd(8)}  ${t.created_at.slice(0, 19)}  ${t.needs_category_review}`);
console.log(`  total: ₹${affected.reduce((a, t) => a + Number(t.amount), 0).toLocaleString("en-IN")}`);

console.log(`\npredating the cache row (left alone): ${predating.length}`);
for (const t of predating) console.log(`  ${t.id}  ${t.transaction_date}  ₹${t.amount}  created ${t.created_at.slice(0, 19)}`);

if (!APPLY) { console.log("\nDRY RUN - nothing written"); process.exit(0); }

let moved = 0;
for (const t of affected) {
  const { error } = await sb.from("transactions").update({
    category_id: QUICK_COMMERCE.id,
    // A person is choosing this, via this script, on the operator's
    // instruction - not the cache and not a rule.
    category_source: "manual",
    needs_category_review: false,
  }).eq("id", t.id);
  if (error) { console.error(`  FAILED txn ${t.id}: ${error.message}`); continue; }
  moved++;
}
console.log(`\nmoved to Quick Commerce: ${moved} of ${affected.length}`);

const { error: delErr } = await sb.from("merchant_categories").delete().eq("payee", KEY);
console.log(delErr ? `FAILED to delete cache row: ${delErr.message}` : `deleted cache row ${KEY} -> Ignore`);
