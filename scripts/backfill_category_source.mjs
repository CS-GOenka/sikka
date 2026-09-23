#!/usr/bin/env node
// Fills transactions.category_source where it can be established from evidence.
//
//   node scripts/backfill_category_source.mjs            # dry run
//   node scripts/backfill_category_source.mjs --apply    # writes
//
// Only two cases are determinable after the fact, and both come from comparing
// a transaction against the cache row for its merchant key:
//
//   cache  the row's category equals what the cache says, and the cache row
//          already existed when the transaction was created. Nothing looked at
//          this transaction; the category came from a decision about a
//          different one.
//   rule   the category is Investments or Indulgence AND the payee matches the
//          hardcoded branch in categorize.ts that assigns it. Those two rules
//          are deterministic, so their output is recognisable.
//
// Everything else stays null, including every transaction whose category
// matches a cache row written LATER - that could be the correction itself, a
// bulk recategorise, or coincidence, and guessing between them would put
// invented provenance in a column whose whole purpose is provenance.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import { payeeKey } from "../src/lib/payeeKey.ts";
import { isPaanShop, isInvestmentTransaction } from "../src/lib/categoryRules.ts";

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

const txns = await selectAll("transactions", "id, payee, note, payment_method, category_id, category_source, created_at");
const mc = await selectAll("merchant_categories", "payee, category_id, confidence_source, updated_at");
const cats = await selectAll("categories", "id, name");
const byName = new Map(cats.map((c) => [c.name, c.id]));
const cacheByKey = new Map(mc.map((r) => [r.payee, r]));

const INVESTMENTS = byName.get("Investments");
const INDULGENCE = byName.get("Indulgence");

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} - ${txns.length} transactions\n`);

const plan = { cache: [], rule: [] };
let already = 0, uncategorised = 0, undeterminable = 0;

for (const t of txns) {
  if (t.category_source != null) { already++; continue; }
  if (t.category_id == null) { uncategorised++; continue; }

  // A deterministic rule wrote this, and the rule can be re-run to prove it.
  const row = { payment_method: t.payment_method, note: t.note, payee: t.payee };
  if (t.category_id === INDULGENCE && isPaanShop(t.payee)) { plan.rule.push(t.id); continue; }
  if (t.category_id === INVESTMENTS && isInvestmentTransaction(row)) { plan.rule.push(t.id); continue; }

  const key = t.payee ? payeeKey(t.payee) : null;
  const cached = key ? cacheByKey.get(key) : null;
  if (cached && cached.category_id === t.category_id && t.created_at >= cached.updated_at) {
    plan.cache.push(t.id);
    continue;
  }
  undeterminable++;
}

console.log(`  already set                : ${already}`);
console.log(`  uncategorised (stays null) : ${uncategorised}`);
console.log(`  -> 'rule'                  : ${plan.rule.length}`);
console.log(`  -> 'cache'                 : ${plan.cache.length}`);
console.log(`  undeterminable (stays null): ${undeterminable}`);
const determinable = plan.rule.length + plan.cache.length;
console.log(`\n${APPLY ? "writing" : "would write"}: ${determinable} of ${txns.length} (${((determinable / txns.length) * 100).toFixed(1)}%)`);

if (APPLY) {
  for (const [source, ids] of Object.entries(plan)) {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error } = await sb.from("transactions").update({ category_source: source }).in("id", chunk);
      if (error) { console.error(`  FAILED ${source} chunk: ${error.message}`); break; }
    }
    console.log(`  wrote ${ids.length} rows as '${source}'`);
  }
}
