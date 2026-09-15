#!/usr/bin/env node
// Pre-seeds merchant_categories for the keys that email ingest will produce.
//
//   node scripts/seed_alias_keys.mjs            # dry run
//   node scripts/seed_alias_keys.mjs --apply    # writes
//
// The email alert and the SMS alert for one charge do not normalise to the same
// cache key, because the SMS cuts the merchant name at 15 characters and the
// email does not. Measured against gmail_staging, 11 of the 909 matched charges
// would arrive under a key that has never been seen, and each one of those is
// an LLM call - a cache miss is the only thing that reaches the model.
//
// Two of them are worse than a wasted call. "book my forex p" and "bundl techn"
// are already categorized; the email's longer spelling keys elsewhere, so an
// email-first ingest would walk straight past an existing answer and ask the
// model to guess again. For "book my forex p" that answer was entered by hand.
//
// So each new key is seeded with the category its SMS twin already has, marked
// confidence_source='hardcoded' - the same label the rule-based branch of
// categorize.ts uses, chosen because it reads as "put here by a rule, not by
// evidence" and because nothing on the read path treats it specially: a seeded
// row is found by the ordinary cache lookup and reported as source 'cache'.
//
// The cost of that label is traceability. These 13 become indistinguishable
// from the 5 rows the real hardcoded rules (paan shops, investments) wrote, so
// the only record of which is which is this script's list.
//
// An existing row is never touched, whatever its source. An inherited category
// is the weakest claim in the table and must never outrank a human's.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--apply");

// [key the email will produce, key the SMS already produces].
// Derived from the 909 matched rows in gmail_staging, plus two from the
// unmatched set whose SMS twin is already categorized.
const ALIAS_PAIRS = [
  ["arvinda", "upi-66182717483"],
  ["social b", "upi-62275900196"],
  ["blore ko", "blore"],
  ["udupi kr", "udupi"],
  ["education sp de", "education sp"],
  ["make my trip", "make my trip i"],
  ["youtube cybs si", "youtube cybs"],
  ["dmart av", "dmart"],
  ["ganesh c", "ganesh"],
  ["shoes sh", "shoes"],
  ["aadri ve", "aadri"],
  // Unmatched in the diff, but their SMS twin holds a category already - and
  // for the first one, a manual one.
  ["book my forex", "book my forex p"],
  ["bundl technologies pr", "bundl techn"],
];

const keys = [...new Set(ALIAS_PAIRS.flat())];
const { data: rows, error } = await sb
  .from("merchant_categories")
  .select("payee, category_id, confidence_source")
  .in("payee", keys);
if (error) throw error;
const { data: cats } = await sb.from("categories").select("id, name");
const catName = (id) => cats.find((c) => c.id === id)?.name ?? "none";
const existing = new Map(rows.map((r) => [r.payee, r]));

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} - ${ALIAS_PAIRS.length} alias pairs\n`);

let seeded = 0, skipped = 0, unseedable = 0;
for (const [newKey, sourceKey] of ALIAS_PAIRS) {
  const source = existing.get(sourceKey);
  if (!source || source.category_id == null) {
    unseedable++;
    console.log(`  SKIP  ${newKey.padEnd(23)} <- ${sourceKey} has no category to inherit`);
    continue;
  }
  const already = existing.get(newKey);
  if (already) {
    // Never overwrite. A manual row is a human decision and outranks everything
    // here; an llm row is at least a real observation of this exact spelling,
    // which an inherited guess is not. Re-running is therefore a no-op.
    skipped++;
    console.log(`  KEEP  ${newKey.padEnd(23)} already ${catName(already.category_id)} / ${already.confidence_source} - not overwritten`);
    continue;
  }
  console.log(`  SEED  ${newKey.padEnd(23)} <- ${sourceKey.padEnd(16)} ${catName(source.category_id)} (${source.category_id}) [from ${source.confidence_source}]`);
  if (APPLY) {
    const { error: insErr } = await sb.from("merchant_categories").insert({
      payee: newKey,
      category_id: source.category_id,
      confidence_source: "hardcoded",
      updated_at: new Date().toISOString(),
    });
    if (insErr) { console.error(`        FAILED: ${insErr.message}`); continue; }
  }
  seeded++;
}

console.log(`\n${APPLY ? "seeded" : "would seed"}: ${seeded}   left alone: ${skipped}   no source category: ${unseedable}`);
