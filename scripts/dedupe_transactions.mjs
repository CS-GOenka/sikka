#!/usr/bin/env node
// Finds and removes transactions that are the same SMS captured twice.
//
//   node scripts/dedupe_transactions.mjs                 # dry run, last 120 days
//   node scripts/dedupe_transactions.mjs --apply         # writes
//   node scripts/dedupe_transactions.mjs --days=365      # widen the window
//
// Why this is needed at all: both duplicate-check layers in /api/ingest are
// deliberately fail-open (see duplicateCheck.ts - "a failed lookup must not
// block ingest"). That is the right call, because silently dropping a real
// transaction is worse than storing one twice. The cost is that a transient
// database blip during a reconcile re-post leaves a duplicate behind, and
// nothing surfaces it. This is the broom for that.
//
// A duplicate is only ever claimed on hard evidence, never on amount alone:
// two charges of the same value to the same merchant on one day are ordinary.
// The proof is the source SMS text -
//   - byte-identical text, or
//   - one text being the other pasted twice (a share-sheet double-paste), or
//   - the same "Avl Bal"/"Avl Limit" figure, which a genuine second charge
//     against the same account cannot report.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--apply");
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=120").split("=")[1]);
const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

const balanceOf = (m) => (m ?? "").match(/Avl\s*(?:Bal|Limit)[^0-9]*([\d,]+\.?\d*)/i)?.[1] ?? null;
const isDoubling = (a, b) => {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return l === s + s || l === `${s}\n${s}` || l === `${s} ${s}`;
};

async function page(table, select, filter) {
  let out = [], from = 0;
  for (;;) {
    let q = sb.from(table).select(select).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out = out.concat(data);
    if (data.length < 1000) return out;
    from += 1000;
  }
}

const txns = await page(
  "transactions",
  "id, payee, amount, type, transaction_date, card_or_account, raw_message_id, starred, related_transaction_id, settlement_group_id, raw_messages(message)",
  (q) => q.gte("transaction_date", since)
);

const groups = new Map();
for (const t of txns) {
  if (t.amount == null) continue;
  const k = [t.type, t.amount, t.transaction_date, t.card_or_account, (t.payee ?? "").toLowerCase()].join("|");
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(t);
}

const confirmed = [];
for (const [key, rows] of groups) {
  if (rows.length < 2) continue;
  rows.sort((a, b) => a.id - b.id);
  const texts = rows.map((r) => r.raw_messages?.message ?? "");
  const bals = texts.map(balanceOf);
  const identical = texts.every((t) => t === texts[0]);
  const doubled = rows.length === 2 && isDoubling(texts[0], texts[1]);
  const sameBal = bals[0] !== null && bals.every((b) => b === bals[0]);
  if (!identical && !doubled && !sameBal) continue;

  // Keep the earliest capture, except never keep a doubled/corrupted text when
  // a clean copy of the same SMS exists.
  const clean = rows.filter((r, i) => !texts.some((t, j) => j !== i && t.length < texts[i].length && isDoubling(t, texts[i])));
  const keep = (clean.length ? clean : rows)[0];
  const drop = rows.filter((r) => r.id !== keep.id);
  const blocked = drop.filter((d) => d.starred || d.related_transaction_id || d.settlement_group_id);
  confirmed.push({ key, keep, drop, blocked, reason: identical ? "identical text" : doubled ? "doubled text" : "same available balance" });
}

console.log(`${txns.length} transactions since ${since}; ${confirmed.length} confirmed duplicate group(s)\n`);
let phantom = 0;
for (const c of confirmed) {
  console.log(`${c.reason.padEnd(24)} ${c.key}`);
  console.log(`   keep txn ${c.keep.id} (raw_message ${c.keep.raw_message_id})`);
  for (const d of c.drop) {
    console.log(`   drop txn ${d.id} (raw_message ${d.raw_message_id})${d.starred ? "  [STARRED - skipped]" : ""}`);
    if (!c.blocked.includes(d) && d.type === "debit") phantom += d.amount;
  }
  if (c.blocked.length) console.log(`   !! ${c.blocked.length} row(s) starred or linked to a settlement/refund - left alone, resolve by hand`);
}
console.log(`\nphantom debit total that would be removed: Rs ${phantom.toLocaleString("en-IN")}`);

// Extra raw_messages carrying a kept group's text but holding no transaction.
// The dedupe query in /api/ingest is .limit(1) with no ordering, so one of
// these can be handed back instead of the row that has a transaction, and the
// duplicate gets minted all over again on the next reconcile.
const allRaw = await page("raw_messages", "id, message, transactions(id)");
const hazards = [];
for (const c of confirmed) {
  const keepText = c.keep.raw_messages?.message;
  if (!keepText) continue;
  for (const r of allRaw) {
    if (r.id === c.keep.raw_message_id) continue;
    if (r.message !== keepText) continue;
    if (r.transactions && (Array.isArray(r.transactions) ? r.transactions.length : true)) continue;
    hazards.push(r.id);
  }
}
if (hazards.length) console.log(`transaction-less raw_messages with a kept group's exact text (would re-mint): ${JSON.stringify(hazards)}`);

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to write.");
  process.exit(0);
}

let droppedTx = 0, droppedRaw = 0;
for (const c of confirmed) {
  for (const d of c.drop) {
    if (c.blocked.includes(d)) continue;
    if ((await sb.from("transactions").delete().eq("id", d.id)).error) { console.error("failed to drop txn", d.id); process.exit(1); }
    if (d.raw_message_id && (await sb.from("raw_messages").delete().eq("id", d.raw_message_id)).error) { console.error("failed to drop raw", d.raw_message_id); process.exit(1); }
    droppedTx++; droppedRaw++;
  }
}
for (const id of hazards) {
  if ((await sb.from("raw_messages").delete().eq("id", id)).error) { console.error("failed to drop raw", id); process.exit(1); }
  droppedRaw++;
}
console.log(`\nApplied: ${droppedTx} duplicate transaction(s) and ${droppedRaw} raw_message(s) removed.`);
