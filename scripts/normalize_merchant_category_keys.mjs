#!/usr/bin/env node
// Re-keys merchant_categories on the normalized payee (src/lib/payeeKey.ts) and
// merges the rows the old raw-string key had split apart.
//
//   node scripts/normalize_merchant_category_keys.mjs            # dry run
//   node scripts/normalize_merchant_category_keys.mjs --apply    # writes
//
// Safe to re-run: payeeKey is idempotent, so a second run finds every row
// already keyed and every group already merged, and does nothing.
//
// Where rows collapse onto one key holding DIFFERENT categories, the script
// refuses to guess and stops. Resolving those automatically is how you quietly
// recategorize hundreds of transactions: the confidence ordering alone would
// have handed the whole Swiggy family to Restaurant/Cafe on the strength of a
// single manual correction to one Rs 2,241 charge, outvoting 531 transactions
// the classifier had put in Swiggy/Zomato. Each conflict is therefore a
// deliberate, recorded decision in CONFLICT_RESOLUTIONS below.
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

// key -> the category_id that key should end up holding.
const CONFLICT_RESOLUTIONS = {
  // 12 of 13 rows and 531 of 532 transactions say Swiggy/Zomato. The lone
  // dissenter is a manual Restaurant/Cafe correction to one charge, which
  // stays on that transaction - only the cache key is settled here.
  swiggy: 20,
};

// Which row survives a merge when the categories already agree.
const PRECEDENCE = ["manual", "mandate", "hardcoded", "llm"];
const rank = (source) => {
  const i = PRECEDENCE.indexOf(source);
  return i === -1 ? PRECEDENCE.length : i;
};
const bestRow = (rows) =>
  [...rows].sort((a, b) =>
    rank(a.confidence_source) - rank(b.confidence_source) ||
    Date.parse(b.updated_at) - Date.parse(a.updated_at)
  )[0];

const { data: all, error } = await sb.from("merchant_categories").select("*");
if (error) {
  console.error("Failed to read merchant_categories:", error.message);
  process.exit(1);
}
const { data: cats } = await sb.from("categories").select("id, name");
const categoryName = Object.fromEntries((cats ?? []).map((c) => [c.id, c.name]));

const groups = new Map();
for (const row of all) {
  const key = payeeKey(row.payee);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

const plan = [];
const unresolved = [];
for (const [key, rows] of groups) {
  const categories = new Set(rows.map((r) => r.category_id));
  let winner;
  if (categories.size > 1) {
    const decided = CONFLICT_RESOLUTIONS[key];
    if (decided === undefined) {
      unresolved.push({ key, rows });
      continue;
    }
    // Keep the most trustworthy row that already holds the decided category,
    // so its confidence_source and updated_at survive rather than being
    // invented here.
    winner = bestRow(rows.filter((r) => r.category_id === decided)) ?? bestRow(rows);
    winner = { ...winner, category_id: decided };
  } else {
    winner = bestRow(rows);
  }
  const losers = rows.filter((r) => r.payee !== winner.payee);
  if (losers.length > 0 || winner.payee !== key) plan.push({ key, rows, winner, losers });
}

if (unresolved.length > 0) {
  console.error(`${unresolved.length} key(s) merge rows with different categories and have no recorded decision.\n`);
  for (const { key, rows } of unresolved) {
    console.error(`  "${key}"`);
    for (const r of rows) {
      console.error(`      ${JSON.stringify(r.payee).padEnd(30)} ${categoryName[r.category_id] ?? r.category_id} (${r.confidence_source})`);
    }
  }
  console.error("\nAdd each to CONFLICT_RESOLUTIONS with the category_id it should hold, then re-run.");
  process.exit(1);
}

const merges = plan.filter((p) => p.losers.length > 0);
console.log(`${all.length} rows -> ${groups.size} distinct keys`);
console.log(`${merges.length} group(s) to merge, ${plan.length - merges.length} row(s) to re-key only\n`);
for (const { key, winner, losers } of merges) {
  console.log(`merge "${key}" -> ${categoryName[winner.category_id] ?? winner.category_id}`);
  console.log(`   keep  ${JSON.stringify(winner.payee)} (${winner.confidence_source})`);
  for (const l of losers) {
    const moved = l.category_id !== winner.category_id ? `  [was ${categoryName[l.category_id] ?? l.category_id}]` : "";
    console.log(`   drop  ${JSON.stringify(l.payee)} (${l.confidence_source})${moved}`);
  }
}

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to write.");
  process.exit(0);
}

let mergedGroups = 0;
let rekeyed = 0;
for (const { key, winner, losers } of plan) {
  // Losers go first, so the unique constraint on payee never sees two rows
  // claiming the same key mid-flight.
  if (losers.length > 0) {
    const { error: delErr } = await sb
      .from("merchant_categories")
      .delete()
      .in("payee", losers.map((l) => l.payee));
    if (delErr) {
      console.error(`Failed to drop merged rows for "${key}":`, delErr.message);
      process.exit(1);
    }
    mergedGroups += 1;
  }
  const { error: upErr } = await sb
    .from("merchant_categories")
    .update({ payee: key, category_id: winner.category_id })
    .eq("payee", winner.payee);
  if (upErr) {
    console.error(`Failed to re-key "${winner.payee}" to "${key}":`, upErr.message);
    process.exit(1);
  }
  rekeyed += 1;
}
console.log(`\nApplied: ${mergedGroups} group(s) merged, ${rekeyed} row(s) written.`);
