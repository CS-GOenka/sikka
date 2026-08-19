import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { RefreshOnVisible } from "@/components/RefreshOnVisible";
import { formatReceived } from "@/lib/formatReceived";
import { getBudgetSettings, budgetDayWindowUtc } from "@/lib/budget";
import { startTiming } from "@/lib/timing";

export const dynamic = "force-dynamic";

type WindowKey = "1h" | "6h" | "today";

const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: "1h", label: "Last 1 hour" },
  { key: "6h", label: "Last 6 hours" },
  { key: "today", label: "Today" },
];

type CaptureRow = {
  id: number;
  payee: string | null;
  amount: number | null;
  currency: string;
  type: string;
  is_transfer: boolean;
  categories: { name: string } | null;
  raw_messages: { created_at: string; phone_received_at: string | null } | null;
};

function formatAmount(amount: number | null, currency: string, type: string) {
  if (amount === null) return "—";
  const sign = type === "debit" ? "-" : type === "credit" ? "+" : "";
  return `${sign}${currency} ${amount.toLocaleString("en-IN")}`;
}

export default async function CaptureCheckPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const endTiming = startTiming("GET /capture-check");
  try {
    return await renderCaptureCheckPage(searchParams);
  } finally {
    endTiming();
  }
}

async function renderCaptureCheckPage(
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
) {
  const { window: windowParam } = await searchParams;
  const raw = Array.isArray(windowParam) ? windowParam[0] : windowParam;
  const active: WindowKey = raw === "6h" || raw === "today" ? raw : "1h";

  // "Today" is the budget day, not the calendar day - it runs from
  // day_reset_hour (default 03:00 IST) so a late-night spend still belongs to
  // the evening it happened on, matching how the daily budget counts it. Read
  // from settings rather than hardcoded so the two can never drift apart.
  const { dayResetHour } = await getBudgetSettings();
  const now = Date.now();
  let startISO: string;
  let windowNote: string;
  if (active === "today") {
    startISO = budgetDayWindowUtc(dayResetHour, now).startISO;
    windowNote = `since ${String(dayResetHour).padStart(2, "0")}:00 IST`;
  } else {
    const hours = active === "6h" ? 6 : 1;
    startISO = new Date(now - hours * 60 * 60 * 1000).toISOString();
    windowNote = `rolling ${hours}h`;
  }

  // Filtered on phone_received_at (when the SMS actually arrived), not
  // created_at (when the row was inserted). They diverge exactly when this
  // screen matters most: a message the Shortcut missed and the Mac reconcile
  // backfilled hours later has a recent created_at but an old
  // phone_received_at, and showing it as "just captured" would hide the very
  // gap you came here to find. !inner so the range filter restricts the
  // transactions themselves, not just the embedded rows.
  const { data, error } = await supabase
    .from("transactions")
    .select(
      "id, payee, amount, currency, type, is_transfer, categories(name), raw_messages!inner(created_at, phone_received_at)"
    )
    .neq("type", "ignored")
    .gte("raw_messages.phone_received_at", startISO)
    .order("id", { ascending: false })
    .returns<CaptureRow[]>();


  if (error) {
    return (
      <main className="p-4">
        <h1 className="text-lg font-semibold">Capture Check</h1>
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">
          Failed to load transactions: {error.message}
        </p>
      </main>
    );
  }

  // Sorted here rather than in the query: ordering the parent rows by an
  // embedded table's column isn't reliably supported, and id order is wrong
  // for this screen anyway - id is insert order, so a message the reconcile
  // backfilled hours late gets a high id and would jump to the top above
  // genuinely newer activity. A window is at most one day, so this is a small
  // list to sort.
  const rows = [...(data ?? [])].sort((a, b) => {
    const at = a.raw_messages?.phone_received_at ?? a.raw_messages?.created_at ?? "";
    const bt = b.raw_messages?.phone_received_at ?? b.raw_messages?.created_at ?? "";
    if (at === bt) return b.id - a.id;
    return at < bt ? 1 : -1;
  });

  return (
    <main className="p-4">
      <RefreshOnVisible />
      <h1 className="text-lg font-semibold">Capture Check</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        What Sikka captured recently. If something you spent is missing, send it in with the Share
        Sheet shortcut.
      </p>

      <div className="mt-4 flex gap-2">
        {WINDOWS.map((w) => {
          const isActive = w.key === active;
          return (
            <Link
              key={w.key}
              href={`/capture-check?window=${w.key}`}
              aria-current={isActive ? "page" : undefined}
              className={
                isActive
                  ? "rounded-full bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                  : "rounded-full border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-950 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-50"
              }
            >
              {w.label}
            </Link>
          );
        })}
      </div>

      <div className="mt-6">
        <div className="text-5xl font-semibold tabular-nums">{rows.length}</div>
        <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {rows.length === 1 ? "transaction" : "transactions"} captured ·{" "}
          {WINDOWS.find((w) => w.key === active)?.label.toLowerCase()} ({windowNote})
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
          Nothing captured in this window. That&apos;s normal if you haven&apos;t spent anything —
          check a wider window before assuming capture is broken.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-zinc-200 dark:divide-zinc-800">
          {rows.map((row) => (
            <li key={row.id} className="flex items-baseline justify-between gap-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{row.payee ?? "—"}</div>
                <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
                  {formatReceived(
                    row.raw_messages?.phone_received_at ?? null,
                    row.raw_messages?.created_at ?? null
                  )}
                  {row.categories?.name ? ` · ${row.categories.name}` : ""}
                  {row.is_transfer ? " · transfer" : ""}
                </div>
              </div>
              <div className="shrink-0 text-sm tabular-nums">
                {formatAmount(row.amount, row.currency, row.type)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
