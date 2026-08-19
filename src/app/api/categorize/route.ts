import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { categorizeTransaction } from "@/lib/categorize";

// Backfill sweep for transactions that have no category yet. Meant to be
// called repeatedly until it reports done - see the cursor note below.
//
// This used to select every uncategorized row and loop over all of them with
// no bound. Since categorizeTransaction hits Gemma on a cache miss, the work
// scaled with the backlog: once the backlog exceeded a few minutes of LLM
// calls the endpoint 504'd on *every* invocation, making it permanently
// un-drainable. The row writes commit inside the loop so the partial progress
// was never lost, but the caller got a gateway error instead of a report and
// had no way to finish the job.
//
// So the work one invocation takes on is now bounded twice - by row count and
// by a wall-clock deadline - and whichever trips first, the response says
// where to resume.
// The platform allows 300s here, and the route needs all of it as headroom.
// An earlier attempt at this fix set 60 - which capped the function *below*
// the 300s it already had and made the timeouts strictly worse.
export const maxDuration = 300;

// Small enough that a full batch cannot plausibly approach maxDuration: rows
// cost ~2.5s each when Gemma is cold, so 10 rows is ~25s typical and ~100s
// even at 10s/row.
const BATCH_SIZE = 10;
// Safety net for pathological slowness, not the primary bound - BATCH_SIZE is.
// The deadline is only checked between rows, and categorizeTransaction has no
// timeout of its own, so one slow Gemma call can overrun the budget by however
// long it takes. Hence the deliberately large gap to maxDuration: enough slack
// that an in-flight call finishing late still lands inside the limit.
const TIME_BUDGET_MS = 120_000;

export async function POST(request: NextRequest) {
  // Cursor, not offset. A row can legitimately end this sweep still holding
  // category_id = null - self-transfers, rows with no payee, and P2P names
  // the classifier refuses to guess at are all left uncategorized on purpose.
  // Those rows never leave the "category_id is null" set, so an offset-free
  // limit would keep handing back the same stuck rows forever and never reach
  // the untouched ones. Paging on ascending id instead guarantees forward
  // progress whatever each row's outcome.
  let after = 0;
  try {
    const body = await request.json();
    const raw = (body as { after?: unknown })?.after;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      after = Math.floor(raw);
    }
  } catch {
    // No body (or not JSON) - start from the beginning. Callers that just
    // POST with no payload keep working.
  }

  const { data: rows, error } = await supabase
    .from("transactions")
    .select("id, payee, payment_method, note")
    .in("type", ["debit", "credit"])
    .is("category_id", null)
    .gt("id", after)
    .order("id", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error("Failed to fetch uncategorized transactions:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    return NextResponse.json({ status: "ERROR", error: error.message }, { status: 500 });
  }

  const results = [];
  const failures = [];
  const deadline = Date.now() + TIME_BUDGET_MS;
  let cursor = after;
  let stoppedOnTime = false;

  for (const row of rows) {
    if (Date.now() > deadline) {
      stoppedOnTime = true;
      break;
    }
    const outcome = await categorizeTransaction(row);
    // Advance past this row either way. A row that errored has already been
    // logged and stays uncategorized; retrying it inside the same sweep would
    // just stall the cursor behind it.
    cursor = row.id;
    if (outcome.error) {
      failures.push({ id: outcome.id, payee: outcome.payee, error: outcome.error });
      continue;
    }
    results.push(outcome);
  }

  // Whether another call would find more work. A short page that ran to
  // completion means the sweep reached the end of the table.
  const done = !stoppedOnTime && rows.length < BATCH_SIZE;

  let remaining: number | null = null;
  if (!done) {
    const { count, error: countError } = await supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .in("type", ["debit", "credit"])
      .is("category_id", null)
      .gt("id", cursor);
    if (countError) {
      console.error("Failed to count remaining uncategorized transactions:", countError);
    } else {
      remaining = count ?? null;
    }
  }

  return NextResponse.json({
    status: "OK",
    categorized: results.length,
    failed: failures.length,
    // Feed nextCursor back as `after` to continue the sweep.
    done,
    nextCursor: done ? null : cursor,
    remaining: done ? 0 : remaining,
    stoppedOnTime,
    results,
    failures,
  });
}
