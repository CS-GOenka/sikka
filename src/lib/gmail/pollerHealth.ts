import { supabase } from "@/lib/supabase";

/**
 * Is the Gmail poller actually doing its job?
 *
 * Both conditions below describe a poller that reports success while failing,
 * which is why they need an external check at all. Neither produces an error
 * anybody would see.
 */

// Runs every 15 minutes, so 45 gives two consecutive misses before anyone is
// woken. One missed run is a cold start or a slow scheduler; three in a row is
// the scheduler being gone.
export const MAX_SILENCE_MINUTES = 45;

// Three consecutive fallbacks. Not one: a single fallback is the correct,
// designed response to a cursor Gmail has aged out, and firing on that would
// train everyone to ignore this. Three in a row means the cursor is never being
// saved, and the "incremental" sync has quietly become a seven-day rescan on
// every run - the same work, the same quota, forever, at HTTP 200.
export const FALLBACK_STREAK = 3;

export interface PollerProblem {
  condition: "stuck-in-fallback" | "no-recent-runs";
  detail: string;
}

export interface PollerHealth {
  ok: boolean;
  problems: PollerProblem[];
  lastRunAt: string | null;
  minutesSinceLastRun: number | null;
  recentFallbacks: boolean[];
}

export async function checkPollerHealth(now: number = Date.now()): Promise<PollerHealth> {
  const { data, error } = await supabase
    .from("gmail_poll_runs")
    .select("ran_at, used_timestamp_fallback")
    .order("ran_at", { ascending: false })
    .limit(FALLBACK_STREAK);

  if (error) {
    // Unreadable is not healthy. Reporting ok here would mean a broken database
    // connection reads as a working poller.
    return {
      ok: false,
      problems: [{ condition: "no-recent-runs", detail: `could not read gmail_poll_runs: ${error.message}` }],
      lastRunAt: null,
      minutesSinceLastRun: null,
      recentFallbacks: [],
    };
  }

  const runs = data ?? [];
  const problems: PollerProblem[] = [];
  const lastRunAt = runs[0]?.ran_at ?? null;
  const minutesSinceLastRun =
    lastRunAt === null ? null : Math.round(((now - Date.parse(lastRunAt)) / 60000) * 10) / 10;

  if (lastRunAt === null) {
    problems.push({ condition: "no-recent-runs", detail: "no poll run has ever been recorded" });
  } else if (minutesSinceLastRun !== null && minutesSinceLastRun > MAX_SILENCE_MINUTES) {
    problems.push({
      condition: "no-recent-runs",
      detail: `last run was ${minutesSinceLastRun} minutes ago at ${lastRunAt}; expected one within ${MAX_SILENCE_MINUTES}`,
    });
  }

  // Requires a full streak of runs to exist. With fewer than three there is no
  // streak to be stuck in, and calling a brand-new poller unhealthy for having
  // run twice would be a false alarm on its first half hour.
  const fallbacks = runs.map((r) => r.used_timestamp_fallback === true);
  if (fallbacks.length === FALLBACK_STREAK && fallbacks.every(Boolean)) {
    problems.push({
      condition: "stuck-in-fallback",
      detail: `the last ${FALLBACK_STREAK} runs all fell back to a date-range query; the history cursor is not being saved`,
    });
  }

  return { ok: problems.length === 0, problems, lastRunAt, minutesSinceLastRun, recentFallbacks: fallbacks };
}
