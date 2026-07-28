import { supabase } from "@/lib/supabase";
import { sendPushToAll } from "@/lib/push";

// The account holder and all transaction data are in IST (UTC+5:30, no DST),
// so budget days are anchored to IST regardless of where the server runs.
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RESET_HOUR = 3;

export interface BudgetSettings {
  dailyBudget: number | null;
  dayResetHour: number;
}

// Reads settings defensively (select * ) so a missing day_reset_hour column
// (before the Stage 2 migration is applied) falls back to the default rather
// than erroring.
export async function getBudgetSettings(): Promise<BudgetSettings> {
  const { data, error } = await supabase.from("settings").select("*").eq("id", 1).maybeSingle();
  if (error) {
    console.error("Failed to read budget settings:", error);
    return { dailyBudget: null, dayResetHour: DEFAULT_RESET_HOUR };
  }
  const row = data as { daily_budget?: number | null; day_reset_hour?: number | null } | null;
  const rawHour = row?.day_reset_hour;
  const dayResetHour =
    typeof rawHour === "number" && Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 23
      ? rawHour
      : DEFAULT_RESET_HOUR;
  return { dailyBudget: row?.daily_budget ?? null, dayResetHour };
}

// [start, end) UTC instants for the budget day containing `nowMs`. The day
// runs resetHour->resetHour on the IST clock: if the current IST hour is
// before resetHour, we're still in the day that started at resetHour on the
// previous IST date.
export function budgetDayWindowUtc(
  resetHour: number,
  nowMs: number = Date.now()
): { startISO: string; endISO: string } {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const mo = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const h = ist.getUTCHours();
  // IST wall-clock ms for resetHour today; shift back a day if we're before it.
  let startWallMs = Date.UTC(y, mo, d, resetHour, 0, 0, 0);
  if (h < resetHour) startWallMs -= DAY_MS;
  const startUtcMs = startWallMs - IST_OFFSET_MS;
  return {
    startISO: new Date(startUtcMs).toISOString(),
    endISO: new Date(startUtcMs + DAY_MS).toISOString(),
  };
}

interface QualifyingRow {
  amount: number | null;
  category_id: number | null;
  categories: { counts_as_spend: boolean } | null;
}

function countsAsSpend(row: { category_id: number | null; categories: { counts_as_spend: boolean } | null }): boolean {
  // Uncategorized debits count by default; a category counts only if its flag
  // is true.
  return row.category_id == null || row.categories?.counts_as_spend === true;
}

// Sum of qualifying spend within the given window. Qualifying = a successful,
// non-transfer INR debit whose category counts as spend (or which has no
// category yet). Uses transactions.created_at for the window since it's always
// present and directly filterable; for a live alert that's ~ the spend moment.
export async function computeTodaySpend(window: { startISO: string; endISO: string }): Promise<number> {
  const { data, error } = await supabase
    .from("transactions")
    .select("amount, category_id, categories(counts_as_spend)")
    .eq("type", "debit")
    .eq("status", "success")
    .eq("is_transfer", false)
    .eq("currency", "INR")
    .gte("created_at", window.startISO)
    .lt("created_at", window.endISO)
    .returns<QualifyingRow[]>();
  if (error) {
    throw new Error(`Failed to compute today's spend: ${error.message}`);
  }
  let total = 0;
  for (const row of data ?? []) {
    if (typeof row.amount === "number" && countsAsSpend(row)) total += row.amount;
  }
  return total;
}

function formatInr(n: number): string {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

interface NotifyRow {
  amount: number | null;
  type: string;
  status: string | null;
  is_transfer: boolean;
  currency: string;
  category_id: number | null;
  categories: { name: string; counts_as_spend: boolean } | null;
}

// Called from the ingest after() step once a transaction has been fully
// classified/categorized. Re-reads the transaction's final state (category and
// is_transfer may have changed during categorization/resolution), and only if
// it's a qualifying spend recalculates today's total and fires one push. Any
// non-qualifying transaction (transfer, credit, investment/ignore category,
// failed, non-INR) fires nothing. Best-effort: never throws into the caller.
export async function notifyBudgetForSpend(transactionId: number, nowMs: number = Date.now()): Promise<void> {
  try {
    const { data: txn, error } = await supabase
      .from("transactions")
      .select("amount, type, status, is_transfer, currency, category_id, categories(name, counts_as_spend)")
      .eq("id", transactionId)
      .single<NotifyRow>();
    if (error || !txn) {
      console.error(`Budget notify: failed to load transaction ${transactionId}:`, error);
      return;
    }

    const qualifies =
      txn.type === "debit" &&
      txn.status === "success" &&
      txn.is_transfer === false &&
      txn.currency === "INR" &&
      typeof txn.amount === "number" &&
      countsAsSpend(txn);
    if (!qualifies) return;

    const { dailyBudget, dayResetHour } = await getBudgetSettings();
    const window = budgetDayWindowUtc(dayResetHour, nowMs);
    const todayTotal = await computeTodaySpend(window);

    const amount = txn.amount as number;
    const categoryName = txn.category_id == null ? "Uncategorized" : txn.categories?.name ?? "Uncategorized";

    const title = `−${formatInr(amount)} · ${categoryName}`;
    let body: string;
    if (dailyBudget == null) {
      body = `Spent today: ${formatInr(todayTotal)} · set a daily budget in Settings`;
    } else {
      const remaining = dailyBudget - todayTotal;
      body =
        remaining >= 0
          ? `${formatInr(remaining)} left today · ${formatInr(todayTotal)} of ${formatInr(dailyBudget)}`
          : `${formatInr(-remaining)} over budget · ${formatInr(todayTotal)} of ${formatInr(dailyBudget)}`;
    }

    await sendPushToAll({ title, body, tag: "sikka-budget", url: "/transactions" });
  } catch (err) {
    console.error(`Budget notify failed for transaction ${transactionId}:`, err);
  }
}
