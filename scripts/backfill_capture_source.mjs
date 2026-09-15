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
//   manual     ANY of three proofs. (1) The text exists in this Mac's Messages
//              database only as an iMessage from a personal number, never as an
//              SMS from a bank shortcode - a human pasted it into a thread, so
//              whatever captured it captured a hand-made copy. (2)
//              phone_received_at is exactly 12:00 IST on the transaction's own
//              date; only backdatedAnchor() writes that, and only for a declared
//              manual capture. (3) The row was created within a minute of a
//              receipt time two or more days later than the date in the message.
//              Proof 3 is the weakest and is listed last for that reason: ICICI
//              genuinely delivers some alerts days late.
//   shortcut   created within 60s of the SMS arriving, and the message is dated
//              within a day of that. Only a sender watching for the message as
//              it lands can do that. The one-day tolerance is for alerts that
//              straddle the IST midnight boundary.
//   reconcile  created more than an hour after the SMS arrived, unanchored, AND
//              one of two or more such rows posted within the same two minutes.
//              The batch is the evidence: the reconcile script sweeps a window
//              and re-posts everything missing from it, so its rows arrive in
//              clumps. A person sharing one old message does not.
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
//   - large-gap rows posted alone rather than in a batch (10 rows). A reconcile
//     run catching a single missed SMS and a person sharing a single old one
//     produce exactly the same row.
//
// The sub-minute rule was wrong on its first pass. raw_message 3464 - an alert
// dated 12-Sep captured on 15-Sep - was created 23 seconds after its receipt
// time and would have been called 'shortcut'; the operator said it had been made
// by hand. Chasing that down is what produced the chat.db test, which turned out
// to be far better evidence than any timing rule: every real bank alert arrives
// with service='SMS' from a shortcode (ICICIO-T, AD-ICICIT-S, JDICICIB), while
// 20 rows arrive as iMessage from one personal number, +91700...329. Ten of
// those twelve distinct texts exist nowhere else in the database. They include
// both halves of the known duplicate pair (transactions 5008 and 5011).
//
// Two of the twelve DO have an SMS twin, so either sender could have produced
// the stored row; those keep whatever the timing rules said. The real fix
// remains for each sender to declare itself in the request.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

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

const rows = await selectAll("raw_messages", "id, message, created_at, phone_received_at, transactions(transaction_date)");
console.log(`${APPLY ? "APPLYING" : "DRY RUN"} - ${rows.length} raw_messages\n`);

// Texts that exist in this Mac's Messages database ONLY as an iMessage from a
// personal number - never as an SMS from a bank shortcode. Read through python3
// because that is the interpreter this machine has granted Full Disk Access;
// the sqlite3 CLI is a different binary and a different TCC decision.
function handPastedTexts() {
  const py = `
import sqlite3, os, json
db = os.path.expanduser("~/Library/Messages/chat.db")
try:
    c = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    c.text_factory = lambda b: b.decode("utf-8", "replace") if isinstance(b, bytes) else b
    cur = c.cursor()
    cur.execute("SELECT DISTINCT text FROM message WHERE text LIKE '%ICICI%' AND service='iMessage'")
    out = []
    for (t,) in cur.fetchall():
        key = t.strip()[:70]
        cur2 = c.cursor()
        cur2.execute("SELECT COUNT(*) FROM message WHERE service='SMS' AND text LIKE ?", ("%" + key + "%",))
        if cur2.fetchone()[0] == 0:
            out.append(t.strip())
    print(json.dumps({"texts": out}))
except Exception as e:
    print(json.dumps({"error": "%s: %s" % (type(e).__name__, e)}))
`;
  try {
    const raw = execFileSync("python3", ["-c", py], { encoding: "utf8", timeout: 20000 });
    const parsed = JSON.parse(raw);
    if (parsed.error) {
      console.log(`  chat.db unreadable (${parsed.error}) - skipping the iMessage proof\n`);
      return [];
    }
    return parsed.texts;
  } catch (err) {
    console.log(`  chat.db unreadable (${err.message}) - skipping the iMessage proof\n`);
    return [];
  }
}

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const pasted = handPastedTexts().map(norm).filter((t) => t.length >= 30);
const pastedIds = new Set();
for (const r of rows) {
  const m = norm(r.message);
  if (pasted.some((p) => m === p || m.startsWith(p.slice(0, 80)))) pastedIds.add(r.id);
}
console.log(`  chat.db: ${pasted.length} texts exist only as iMessage from a personal number -> ${pastedIds.size} raw_messages\n`);

// 12:00 IST is 06:30:00.000Z on the same calendar day.
const isAnchored = (r) =>
  !!r.phone_received_at &&
  r.phone_received_at.slice(11, 19) === "06:30:00" &&
  r.transactions?.transaction_date === r.phone_received_at.slice(0, 10);

// Calendar days between the date in the message and the IST day it was received.
function daysStale(r) {
  const td = r.transactions?.transaction_date;
  if (!td || !r.phone_received_at) return null;
  const received = new Date(r.phone_received_at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return Math.round((Date.parse(received) - Date.parse(td)) / 86400000);
}

function classify(r, batched) {
  if (r.created_at.slice(0, 10) < IMPORT_ENDED) return null;   // historical import
  if (pastedIds.has(r.id)) return "manual";                    // proof 1, strongest
  if (isAnchored(r)) return "manual";
  if (!r.phone_received_at) return null;
  const gap = (Date.parse(r.created_at) - Date.parse(r.phone_received_at)) / 1000;
  if (gap < ONE_MINUTE) {
    const stale = daysStale(r);
    // Posted instantly, but reporting a charge from days ago: shared by hand.
    return stale !== null && stale >= 2 ? "manual" : "shortcut";
  }
  if (gap > ONE_HOUR) return batched.has(r.id) ? "reconcile" : null;
  return null;                                                  // 1 min - 1 h
}

// Rows the reconcile script posted arrive in batches; a hand-shared message
// arrives alone. Computed over the large-gap rows only, in created_at order.
const BATCH_WINDOW_MS = 120 * 1000;
const batched = new Set();
const lateRows = rows
  .filter((r) => r.created_at.slice(0, 10) >= IMPORT_ENDED && !isAnchored(r) && r.phone_received_at &&
    (Date.parse(r.created_at) - Date.parse(r.phone_received_at)) / 1000 > ONE_HOUR)
  .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
let run = [];
const flush = () => { if (run.length >= 2) for (const r of run) batched.add(r.id); run = []; };
for (const r of lateRows) {
  if (run.length && Date.parse(r.created_at) - Date.parse(run[run.length - 1].created_at) > BATCH_WINDOW_MS) flush();
  run.push(r);
}
flush();

const plan = new Map([["shortcut", []], ["reconcile", []], ["manual", []]]);
let left = 0;
for (const r of rows) {
  const label = classify(r, batched);
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
