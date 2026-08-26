#!/usr/bin/env node
// Converts foreign-currency card transactions that predate the FX pipeline,
// and retries any left flagged fx_pending.
//
//   node scripts/backfill_fx.mjs            # dry run - shows what it would do
//   node scripts/backfill_fx.mjs --apply    # writes
//
// Safe to re-run: an already-converted row has currency 'INR' and is no longer
// selected, so a second run is a no-op rather than a double conversion.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--apply");

const FX_MARKUP_RATE = 0.035;
const GST_ON_MARKUP_RATE = 0.18;
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

function convertToInr(amount, rate) {
  const baseInr = round2(amount * rate);
  const markupInr = round2(baseInr * FX_MARKUP_RATE);
  const gstInr = round2(markupInr * GST_ON_MARKUP_RATE);
  return { baseInr, markupInr, gstInr, totalInr: round2(baseInr + markupInr + gstInr) };
}

async function getRate(currency, date) {
  const { data: cached } = await sb.from("fx_rates")
    .select("rate, effective_date, provider").eq("currency", currency).eq("rate_date", date).maybeSingle();
  if (cached) return { rate: Number(cached.rate), effectiveDate: cached.effective_date, cached: true };

  const res = await fetch(`https://api.frankfurter.dev/v1/${date}?base=${currency}&symbols=INR`,
    { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const body = await res.json();
  const rate = body?.rates?.INR;
  if (typeof rate !== "number" || rate <= 0) return null;

  if (APPLY) {
    await sb.from("fx_rates").upsert({
      currency, rate_date: date, rate, effective_date: body.date ?? date,
      provider: "frankfurter", fetched_at: new Date().toISOString(),
    }, { onConflict: "currency,rate_date" });
  }
  return { rate, effectiveDate: body.date ?? date, cached: false };
}

const { data: rows, error } = await sb.from("transactions")
  // Deliberately does not select the FX columns: a dry run has to work before
  // the migration is applied, which is exactly when it is most useful.
  .select("id, currency, amount, type, status, payment_method, transaction_date, payee")
  .neq("currency", "INR")
  .order("transaction_date", { ascending: true });
if (error) throw error;

// Same rule as src/lib/fx/eligibility.ts: a real foreign card charge, not a
// mandate ceiling or a declined attempt.
const eligible = rows.filter((t) =>
  t.currency && t.currency !== "INR" &&
  typeof t.amount === "number" && t.amount > 0 &&
  (t.type === "debit" || t.type === "credit") &&
  t.status === "success" && t.payment_method === "card" && t.transaction_date);
const skipped = rows.filter((r) => !eligible.includes(r));

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} - ${rows.length} non-INR rows, ${eligible.length} convertible, ${skipped.length} skipped\n`);

let converted = 0, pending = 0, totalInr = 0;
for (const t of eligible) {
  const quote = await getRate(t.currency, t.transaction_date);
  if (!quote) {
    pending++;
    console.log(`  PENDING  id=${t.id} ${t.currency} ${t.amount} on ${t.transaction_date} - no rate`);
    if (APPLY) await sb.from("transactions").update({ fx_pending: true }).eq("id", t.id);
    continue;
  }
  const b = convertToInr(t.amount, quote.rate);
  totalInr += b.totalInr;
  console.log(`  ${t.currency} ${String(t.amount).padStart(7)} on ${t.transaction_date} @ ${quote.rate}` +
    `${quote.effectiveDate !== t.transaction_date ? ` (priced ${quote.effectiveDate})` : ""}` +
    ` -> base ₹${b.baseInr} + ₹${b.markupInr} + ₹${b.gstInr} = ₹${b.totalInr}   ${t.payee ?? ""}`);
  if (APPLY) {
    const { error: upErr } = await sb.from("transactions").update({
      amount: b.totalInr, currency: "INR",
      original_amount: t.amount, original_currency: t.currency,
      fx_rate: quote.rate, fx_rate_date: quote.effectiveDate, fx_pending: false,
    }).eq("id", t.id);
    if (upErr) { console.error(`  FAILED id=${t.id}:`, upErr.message); continue; }
  }
  converted++;
}

console.log(`\n${APPLY ? "converted" : "would convert"}: ${converted}   pending: ${pending}   total added to spend: ₹${round2(totalInr).toLocaleString("en-IN")}`);
if (skipped.length) {
  console.log(`\nskipped (correctly - not real foreign card charges):`);
  for (const t of skipped) console.log(`  id=${t.id} ${t.currency} ${t.amount} type=${t.type} status=${t.status} method=${t.payment_method} date=${t.transaction_date ?? "none"}`);
}
