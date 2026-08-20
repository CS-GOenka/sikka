import { supabase } from "@/lib/supabase";
import { sendPushToAll } from "@/lib/push";
import { formatInr as formatInrBase } from "@/lib/formatInr";

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

// A qualifying debit, with enough category context for the dashboard to roll
// subcategories up into their parent. The dashboard needs the individual rows,
// not just a sum, so the fetch lives here - one definition of "qualifying
// spend" that both the budget total and the breakdown read from.
export interface SpendRow {
  id: number;
  amount: number;
  payee: string | null;
  categoryId: number | null;
  categoryName: string | null;
  parentId: number | null;
  receivedAt: string | null;
  paymentMethod: string | null;
  accountType: string | null;
  cardOrAccount: string | null;
  transactionDate: string | null;
  note: string | null;
  starred: boolean;
}

interface SpendQueryRow {
  id: number;
  amount: number | null;
  payee: string | null;
  payment_method: string | null;
  account_type: string | null;
  card_or_account: string | null;
  transaction_date: string | null;
  note: string | null;
  starred: boolean | null;
  category_id: number | null;
  categories: { counts_as_spend: boolean; name: string; parent_id: number | null } | null;
  raw_messages: { phone_received_at: string | null } | null;
}

function countsAsSpend(row: { category_id: number | null; categories: { counts_as_spend: boolean } | null }): boolean {
  // Uncategorized debits count by default; a category counts only if its flag
  // is true.
  return row.category_id == null || row.categories?.counts_as_spend === true;
}

// The qualifying spend rows within the given window. Qualifying = a successful,
// non-transfer INR debit whose category counts as spend (or which has no
// category yet). The day boundary is anchored on raw_messages.phone_received_at
// (when the SMS was actually received on the phone ~ when the spend happened),
// normalized to canonical UTC ISO-8601 at ingest so it sorts/compares as text.
// created_at is deliberately NOT used - it reflects when a row was inserted,
// which is wrong for backfilled/reconciled data. The !inner join makes the
// phone_received_at range filter restrict the transactions, not just the embed.
export async function fetchQualifyingSpendRows(window: {
  startISO: string;
  endISO: string;
}): Promise<SpendRow[]> {
  const { data, error } = await supabase
    .from("transactions")
    .select(
      "id, amount, payee, payment_method, account_type, card_or_account, transaction_date, note, starred, category_id, categories(counts_as_spend, name, parent_id), raw_messages!inner(phone_received_at)"
    )
    .eq("type", "debit")
    .eq("status", "success")
    .eq("is_transfer", false)
    .eq("currency", "INR")
    .gte("raw_messages.phone_received_at", window.startISO)
    .lt("raw_messages.phone_received_at", window.endISO)
    .returns<SpendQueryRow[]>();
  if (error) {
    throw new Error(`Failed to compute today's spend: ${error.message}`);
  }
  const rows: SpendRow[] = [];
  for (const row of data ?? []) {
    if (typeof row.amount !== "number" || !countsAsSpend(row)) continue;
    rows.push({
      id: row.id,
      amount: row.amount,
      payee: row.payee,
      categoryId: row.category_id,
      categoryName: row.categories?.name ?? null,
      parentId: row.categories?.parent_id ?? null,
      receivedAt: row.raw_messages?.phone_received_at ?? null,
      paymentMethod: row.payment_method,
      accountType: row.account_type,
      cardOrAccount: row.card_or_account,
      transactionDate: row.transaction_date,
      note: row.note,
      starred: row.starred === true,
    });
  }
  return rows;
}

export function sumSpendRows(rows: SpendRow[]): number {
  let total = 0;
  for (const row of rows) total += row.amount;
  return total;
}

export async function computeTodaySpend(window: { startISO: string; endISO: string }): Promise<number> {
  return sumSpendRows(await fetchQualifyingSpendRows(window));
}

// Push copy quotes a specific transaction, so it keeps paise.
function formatInr(n: number): string {
  return formatInrBase(n, 2);
}

interface NotifyRow {
  amount: number | null;
  type: string;
  status: string | null;
  is_transfer: boolean;
  currency: string;
  category_id: number | null;
  payee: string | null;
  categories: { name: string; counts_as_spend: boolean } | null;
  raw_messages: { phone_received_at: string | null } | null;
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
      .select(
        "amount, type, status, is_transfer, currency, category_id, payee, categories(name, counts_as_spend), raw_messages(phone_received_at)"
      )
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

    // Only alert for a spend that belongs to the *current* budget day, keyed on
    // when the SMS was received on the phone. A backfilled/reconciled old debit
    // whose phone_received_at falls outside the current window shouldn't fire a
    // "remaining today" alert - and it's excluded from today's total anyway.
    const ph = txn.raw_messages?.phone_received_at;
    if (!ph) return; // no reliable receipt time - can't place it in a budget day
    const phMs = Date.parse(ph);
    if (Number.isNaN(phMs) || phMs < Date.parse(window.startISO) || phMs >= Date.parse(window.endISO)) return;

    const todayTotal = await computeTodaySpend(window);

    const amount = txn.amount as number;
    const categoryName = txn.category_id == null ? "Uncategorized" : txn.categories?.name ?? "Uncategorized";
    const payeeLabel = txn.payee?.trim() || null;

    // Title leads with the amount and who it was paid to (the most recognizable
    // at a glance); the category and budget status go in the body.
    const title = payeeLabel ? `−${formatInr(amount)} · ${payeeLabel}` : `−${formatInr(amount)} · ${categoryName}`;
    let body: string;
    if (dailyBudget == null) {
      body = `${categoryName} · spent today ${formatInr(todayTotal)} · set a daily budget in Settings`;
    } else {
      const remaining = dailyBudget - todayTotal;
      const budgetStatus =
        remaining >= 0
          ? `${formatInr(remaining)} left today`
          : `${formatInr(-remaining)} over budget`;
      body = `${categoryName} · ${budgetStatus} · ${formatInr(todayTotal)} of ${formatInr(dailyBudget)}`;
    }

    await sendPushToAll({ title, body, tag: "sikka-budget", url: "/transactions" });
  } catch (err) {
    console.error(`Budget notify failed for transaction ${transactionId}:`, err);
  }
}
