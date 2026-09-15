#!/usr/bin/env node
// Labels raw_messages.capture_source where the source is provable from data
// already stored. Everything else is left null.
//
//   node scripts/backfill_capture_source.mjs            # dry run
//   node scripts/backfill_capture_source.mjs --apply    # writes
//
// No sender records who it is. /api/ingest reads a `source` field to decide
// receipt-time precedence, but the reconcile script posts only
// {message, phoneReceivedAt} and the SMS automation posts the same shape - as
// src/lib/receivedAt.ts puts it, "the server cannot tell them apart by
// inspecting the payload". So the label has to be reconstructed from side
// effects, and only where a side effect is unambiguous:
//
//   manual     phone_received_at is exactly 12:00 IST on the transaction's own
//              date. Only backdatedAnchor() writes that, and only for a manual
//              capture carrying a usable past date. Nothing else lands on the
//              second.
//   shortcut   the row was created within 60s of the SMS arriving. Only a
//              sender watching for the message as it lands can do that.
//   reconcile  the row was created more than an hour after the SMS arrived and
//              carries no anchor. A manual capture of a past-dated message is
//              always anchored, so a large unanchored gap leaves the reconcile
//              script as the only writer that could have produced it.
//
// Left null, deliberately:
//
//   - every row from the July 2026 historical import (created before 23 Jul,
//     3,010 rows). They were bulk-loaded from the phone's message history, and
//     whether that went through the reconcile script or a one-off loader is not
//     recorded anywhere. Guessing 'reconcile' for 92% of the table to avoid
//     admitting that would be the worst outcome here.
//   - gaps between one minute and one hour (11 rows). Both a slow shortcut post
//     and a fast reconcile pass live in that range.
//
// The one case 'shortcut' cannot exclude: a Share Sheet capture of a message
// whose date is TODAY gets no anchor and posts immediately, so it is
// indistinguishable from the automation. The real fix is for each sender to
// declare itself; this backfill is what can be recovered without that.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--apply");

// First day on which live capture, rather than the import, was writing rows.
const IMPORT_ENDED = "2026-07-23";
const ONE_MINUTE = 60, ONE_HOUR = 3600;

async function selectAll(table, columns) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

const rows = await selectAll("raw_messages", "id, created_at, phone_received_at, transactions(transaction_date)");
console.log(`${APPLY ? "APPLYING" : "DRY RUN"} - ${rows.length} raw_messages\n`);

// 12:00 IST is 06:30:00.000Z on the same calendar day.
const isAnchored = (r) =>
  !!r.phone_received_at &&
  r.phone_received_at.slice(11, 19) === "06:30:00" &&
  r.transactions?.transaction_date === r.phone_received_at.slice(0, 10);

function classify(r) {
  if (r.created_at.slice(0, 10) < IMPORT_ENDED) return null;   // historical import
  if (isAnchored(r)) return "manual";
  if (!r.phone_received_at) return null;
  const gap = (Date.parse(r.created_at) - Date.parse(r.phone_received_at)) / 1000;
  if (gap < ONE_MINUTE) return "shortcut";
  if (gap > ONE_HOUR) return "reconcile";
  return null;                                                  // 1 min - 1 h
}

const plan = new Map([["shortcut", []], ["reconcile", []], ["manual", []]]);
let left = 0;
for (const r of rows) {
  const label = classify(r);
  if (label === null) { left++; continue; }
  plan.get(label).push(r.id);
}

for (const [label, ids] of plan) {
  console.log(`  ${label.padEnd(10)} ${String(ids.length).padStart(4)} rows   e.g. ${ids.slice(0, 5).join(", ")}`);
  if (APPLY && ids.length) {
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await sb.from("raw_messages").update({ capture_source: label }).in("id", ids.slice(i, i + 200));
      if (error) { console.error(`    FAILED: ${error.message}`); break; }
    }
  }
}
console.log(`  ${"(null)".padEnd(10)} ${String(left).padStart(4)} rows   left undetermined`);
console.log(`\n${APPLY ? "labelled" : "would label"}: ${rows.length - left} of ${rows.length}`);
