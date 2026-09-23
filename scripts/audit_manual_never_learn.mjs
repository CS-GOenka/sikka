#!/usr/bin/env node
// Reports which manual merchant_categories rows point at a category that should
// never have been learned. Read-only: it deletes nothing and changes nothing.
//
//   node scripts/audit_manual_never_learn.mjs
//
// Two separate findings, kept apart because they need different decisions:
//
//   FLAGGED   the target category is never_learn. The rule exists and is
//             actively generalising an occasion to a merchant.
//   DIVERGENT the target is learnable, but the key's transactions are spread
//             across several categories anyway - evidence the merchant is not
//             single-purpose even though its category is.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import { payeeKey } from "../src/lib/payeeKey.ts";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function selectAll(table, columns) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

const mc = await selectAll("merchant_categories", "payee, category_id, confidence_source, updated_at");
// select * so this runs before the never_learn migration as well as after -
// the audit's whole job is to inform a decision about applying it.
const cats = await selectAll("categories", "*");
const txns = await selectAll("transactions", "id, payee, amount, category_id, created_at, transaction_date");
const cat = new Map(cats.map((c) => [c.id, c]));
const cname = (id) => (id == null ? "(uncat)" : cat.get(id)?.name ?? `?${id}`);

// never_learn may not exist yet; fall back to the intended set by name so the
// audit is runnable before the migration lands.
const FALLBACK_ROOTS = ["Ignore", "House RFS", "Gifts"];
const fallbackIds = new Set();
for (const c of cats) {
  if (FALLBACK_ROOTS.includes(c.name)) fallbackIds.add(c.id);
  const parent = c.parent_id ? cat.get(c.parent_id) : null;
  if (parent && FALLBACK_ROOTS.includes(parent.name)) fallbackIds.add(c.id);
}
const hasColumn = cats.some((c) => c.never_learn !== undefined);
const isNeverLearn = (id) => (hasColumn ? cat.get(id)?.never_learn === true : fallbackIds.has(id));
console.log(`never_learn column present: ${hasColumn}${hasColumn ? "" : " - using the intended set by name"}`);

const byKey = new Map();
for (const t of txns) {
  if (!t.payee) continue;
  const k = payeeKey(t.payee);
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(t);
}

const manual = mc.filter((r) => r.confidence_source === "manual");
const flagged = [], divergent = [];
for (const m of manual) {
  const ts = byKey.get(m.payee) ?? [];
  const spread = [...new Set(ts.map((t) => cname(t.category_id)))];
  const carrying = ts.filter((t) => t.category_id === m.category_id);
  const inherited = ts.filter((t) => t.category_id === m.category_id && t.created_at >= m.updated_at);
  const rec = {
    key: m.payee, category: cname(m.category_id), set: m.updated_at.slice(0, 19),
    txns: ts.length, carrying: carrying.length, inherited: inherited.length,
    amount: +ts.filter((t) => t.category_id === m.category_id).reduce((a, t) => a + Number(t.amount || 0), 0).toFixed(2),
    spread,
  };
  if (isNeverLearn(m.category_id)) flagged.push(rec);
  else if (spread.length >= 3) divergent.push(rec);
}

const inr = (n) => "₹" + Number(n).toLocaleString("en-IN");
console.log(`\nmanual rows: ${manual.length}`);
console.log(`\n########## FLAGGED: manual rows targeting a never_learn category (${flagged.length}) ##########`);
console.log("key                   category        set                  txns carry inherit   ₹ carrying   key also seen in");
for (const r of flagged.sort((a, b) => b.inherited - a.inherited || b.txns - a.txns))
  console.log(`  ${r.key.padEnd(20)} ${r.category.padEnd(15)} ${r.set}  ${String(r.txns).padStart(4)}${String(r.carrying).padStart(6)}${String(r.inherited).padStart(8)}   ${inr(r.amount).padStart(11)}   ${r.spread.join(", ")}`);
console.log(`\n  flagged rows still actively inheriting: ${flagged.filter((r) => r.inherited > 0).length}`);

console.log(`\n########## DIVERGENT: learnable category, but the key spans 3+ categories (${divergent.length}) ##########`);
console.log("key                   category        txns  spans");
for (const r of divergent.sort((a, b) => b.spread.length - a.spread.length))
  console.log(`  ${r.key.padEnd(20)} ${r.category.padEnd(15)} ${String(r.txns).padStart(4)}  ${r.spread.length}: ${r.spread.join(", ")}`);
console.log("\nnothing was deleted or changed.");
