import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cronAuth";
import { supabase } from "@/lib/supabase";
import { refreshAccessToken } from "@/lib/gmail/auth";
import { iciciTransactionQuery } from "@/lib/gmail/query";
import { getMessage, getProfile, listAddedMessageIds, listMessageIds, HistoryTooOldError } from "@/lib/gmail/client";
import { extractBody } from "@/lib/gmail/body";
import { parseCardAlert } from "@/lib/gmail/parseCardAlert";
import {
  buildTransactionIndexes,
  classifyAgainstTransactions,
  insertEmailTransaction,
  planInsert,
  type StagedRow,
  type TransactionRow,
} from "@/lib/gmail/ingest";

/**
 * Polls Gmail for ICICI credit-card alerts and turns the ones the SMS pipeline
 * missed into transactions.
 *
 * The SMS channel is still primary. This exists because ICICI demonstrably sends
 * some alerts by email only: three charges on 13 September 2026 totalling
 * ₹22,932 reached the mailbox and never reached the phone at all - not even an
 * OTP - and two more arrived as an OTP with no debit alert behind it.
 *
 * Unlike the backfill script, a NO MATCH row here IS ingested. The backfill was
 * looking 24 months into the past, where a missing transaction could mean the
 * matcher was wrong; going forward the SMS has had its chance by the time this
 * runs, so an alert with no counterpart is a charge nobody recorded. Every row
 * it creates is flagged for review regardless, because email-only is exactly the
 * case nothing else has corroborated.
 *
 * No model calls. A category comes from merchant_categories or the row lands
 * uncategorized.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// How far back the fallback query reaches. Gmail retains roughly a week of
// history, so seven days is the window that cannot leave a hole between the last
// usable cursor and now.
const FALLBACK_DAYS = 7;

// Staged rows older than this are not re-examined on every run. The 24-month
// backfill already settled them, and re-deciding 939 rows every fifteen minutes
// would mean an old row could be re-litigated by a future change to the matcher
// with nobody watching. Recent rows ARE re-examined, so a run that staged
// something but failed to insert it heals itself on the next pass.
const RECONSIDER_WINDOW_DAYS = 30;

export async function GET(request: NextRequest) {
  return handle(request);
}
export async function POST(request: NextRequest) {
  return handle(request);
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  const startedAt = Date.now();
  const errors: string[] = [];
  const run = {
    emails_fetched: 0,
    staged: 0,
    inserted: 0,
    skipped_as_duplicate: 0,
    quarantined: 0,
    ambiguous: 0,
    history_id_before: null as string | null,
    history_id_after: null as string | null,
    used_timestamp_fallback: false,
    fallback_reason: null as string | null,
  };
  const inserted: { transactionId: number; amount: number; payee: string; date: string }[] = [];
  const noMatchIngested: string[] = [];

  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error("Gmail is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN)");
    }
    const { access_token: accessToken } = await refreshAccessToken(refreshToken, clientId, clientSecret);

    const { data: state } = await supabase
      .from("gmail_sync_state")
      .select("last_history_id")
      .eq("id", 1)
      .maybeSingle();
    run.history_id_before = state?.last_history_id ?? null;

    // The cursor Gmail is at right now, read BEFORE any fetching so nothing that
    // arrives mid-run is skipped on the next pass. Saved only if the run gets
    // far enough to have processed what it found.
    const profile = await getProfile(accessToken);

    let candidateIds: string[];
    if (!run.history_id_before) {
      // First run. There is no cursor to be incremental from, and that is not a
      // failure - it is just the bootstrap, so it is not logged as a fallback.
      candidateIds = await listMessageIds(iciciTransactionQuery(FALLBACK_DAYS), accessToken);
    } else {
      try {
        const addedIds = await listAddedMessageIds(run.history_id_before, accessToken);
        // history.list reports every message added to the mailbox, ICICI or not.
        // Intersecting with the pinned sender+subject query is what keeps this
        // from fetching unrelated mail: the history call says what is new, the
        // query says which of it is ours.
        if (addedIds.length === 0) {
          candidateIds = [];
        } else {
          const ours = new Set(await listMessageIds(iciciTransactionQuery(2), accessToken));
          candidateIds = addedIds.filter((id) => ours.has(id));
        }
      } catch (err) {
        if (!(err instanceof HistoryTooOldError)) throw err;
        run.used_timestamp_fallback = true;
        run.fallback_reason = err.cause.slice(0, 300);
        console.warn(
          `Gmail history cursor ${run.history_id_before} was refused; falling back to a ${FALLBACK_DAYS}-day query. Reason: ${err.cause}`
        );
        candidateIds = await listMessageIds(iciciTransactionQuery(FALLBACK_DAYS), accessToken);
      }
    }

    // Anything already staged needs no second fetch; messages.get is the
    // expensive call and a 7-day fallback window re-lists the same ids every run.
    const { data: existingStaged } = await supabase
      .from("gmail_staging")
      .select("gmail_message_id")
      .in("gmail_message_id", candidateIds.length ? candidateIds : ["__none__"]);
    const alreadyStaged = new Set((existingStaged ?? []).map((r) => r.gmail_message_id));
    const toFetch = candidateIds.filter((id) => !alreadyStaged.has(id));

    for (const id of toFetch) {
      try {
        const message = await getMessage(id, accessToken);
        run.emails_fetched++;
        const { text } = extractBody(message.payload);
        const parsed = parseCardAlert({ id: message.id, internalDate: message.internalDate, body: text });
        const { error } = await supabase.from("gmail_staging").upsert(parsed, { onConflict: "gmail_message_id" });
        if (error) {
          errors.push(`stage ${id}: ${error.message}`);
          continue;
        }
        run.staged++;
        if (parsed.status === "quarantine") run.quarantined++;
      } catch (err) {
        errors.push(`fetch ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Now the reader, over staged rows recent enough to still be in question.
    const sinceMs = Date.now() - RECONSIDER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const { data: stagedRows, error: stagedError } = await supabase
      .from("gmail_staging")
      .select("gmail_message_id, internal_date, status, amount, card_last4, payee_email, raw_body")
      .eq("status", "success")
      .gte("internal_date", sinceMs)
      .order("internal_date", { ascending: true })
      .returns<StagedRow[]>();
    if (stagedError) throw new Error(`reading gmail_staging: ${stagedError.message}`);

    const { data: txRows, error: txError } = await supabase
      .from("transactions")
      .select("id, payee, note, amount, card_or_account, transaction_date, gmail_message_id, raw_messages(phone_received_at)")
      .gte("transaction_date", new Date(sinceMs - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
      .returns<TransactionRow[]>();
    if (txError) throw new Error(`reading transactions: ${txError.message}`);

    // Every email-ingested id, not only the recent ones: the unique index makes a
    // repeat insert fail anyway, but failing on purpose is not a check.
    const { data: ingestedRows } = await supabase
      .from("transactions")
      .select("gmail_message_id")
      .not("gmail_message_id", "is", null);
    const indexes = buildTransactionIndexes(txRows ?? []);
    for (const r of ingestedRows ?? []) {
      if (r.gmail_message_id) indexes.ingestedGmailIds.add(r.gmail_message_id);
    }

    const { data: cacheRows } = await supabase
      .from("merchant_categories")
      .select("payee, category_id, confidence_source");
    const cache = new Map((cacheRows ?? []).map((r) => [r.payee, r]));

    for (const row of stagedRows ?? []) {
      const verdict = classifyAgainstTransactions(row, indexes);
      if (verdict.kind === "already-ingested" || verdict.kind === "duplicate") {
        run.skipped_as_duplicate++;
        continue;
      }
      if (verdict.kind === "ambiguous") {
        run.ambiguous++;
        continue;
      }
      const plan = planInsert(row, cache);
      const result = await insertEmailTransaction(supabase, plan);
      if ("error" in result) {
        errors.push(`insert ${plan.gmail_message_id}: ${result.error}`);
        continue;
      }
      run.inserted++;
      inserted.push({ transactionId: result.transactionId, amount: plan.amount, payee: plan.payee, date: plan.transaction_date });
      noMatchIngested.push(plan.gmail_message_id);
      // Keep the in-run index honest: two staged alerts for one charge must not
      // both become transactions inside a single pass.
      indexes.ingestedGmailIds.add(plan.gmail_message_id);
      const fingerprint = `${plan.card_or_account}|${plan.amount}|${plan.transaction_date}`;
      const list = indexes.byFingerprint.get(fingerprint) ?? [];
      list.push({
        id: result.transactionId,
        payee: plan.payee,
        note: plan.payee_email,
        amount: plan.amount,
        card_or_account: plan.card_or_account,
        transaction_date: plan.transaction_date,
        gmail_message_id: plan.gmail_message_id,
        raw_messages: { phone_received_at: new Date(plan.internal_date).toISOString() },
      });
      indexes.byFingerprint.set(fingerprint, list);
    }

    // The cursor only advances once the run has processed what it found. An
    // early crash leaves it where it was, so the next run re-reads rather than
    // skipping the window that failed.
    run.history_id_after = profile.historyId;
    const { error: stateError } = await supabase
      .from("gmail_sync_state")
      .update({ last_history_id: profile.historyId, updated_at: new Date().toISOString() })
      .eq("id", 1);
    if (stateError) errors.push(`saving cursor: ${stateError.message}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Gmail poll failed:", message);
    errors.push(message);
  }

  const duration_ms = Date.now() - startedAt;
  // Written whether or not the run worked. A failed run that leaves no trace is
  // indistinguishable from a run that never fired.
  const { data: record, error: recordError } = await supabase
    .from("gmail_poll_runs")
    .insert({ ...run, duration_ms, errors })
    .select("*")
    .single();
  if (recordError) console.error("Failed to write gmail_poll_runs record:", recordError.message);

  const ok = errors.length === 0;
  return NextResponse.json(
    { status: ok ? "OK" : "ERROR", run: record ?? { ...run, duration_ms, errors }, inserted, noMatchIngested },
    { status: ok ? 200 : 500 }
  );
}
