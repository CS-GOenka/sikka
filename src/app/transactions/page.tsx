import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { getAssignableCategories } from "@/lib/gemini";
import { RefreshOnVisible } from "@/components/RefreshOnVisible";
import { TransactionRow, type RowData } from "@/components/TransactionRow";
import { TransactionFilters, type FilterOption } from "@/components/TransactionFilters";
import { GroupSelectionProvider, type SelectableTransaction } from "@/components/GroupSelectionProvider";
import { RejectedCaptureCallout } from "@/components/RejectedCaptureCallout";
import { fetchPendingRejections } from "@/lib/rejectedCaptures";
import { formatReceived, formatReceivedShort } from "@/lib/formatReceived";
import { startTiming } from "@/lib/timing";
import {
  parseListState,
  buildQuery,
  hasAnyFilter,
  istDayStartUtc,
  istDayEndUtc,
  SORT_COLUMN,
  UNCATEGORIZED,
  type SortKey,
  type SortDir,
} from "@/lib/transactionQuery";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type TransactionQueryRow = {
  id: number;
  payee: string | null;
  amount: number | null;
  currency: string;
  transaction_date: string | null;
  type: string;
  payment_method: string;
  status: string | null;
  account_type: string | null;
  card_or_account: string | null;
  note: string | null;
  is_transfer: boolean;
  starred: boolean;
  settlement_group_id: number | null;
  settlement_groups: { name: string } | null;
  categories: { name: string } | null;
  raw_messages: { created_at: string; phone_received_at: string | null } | null;
};

const METHOD_OPTIONS: FilterOption[] = [
  "upi", "card", "neft", "imps", "rtgs", "ach", "mandate",
].map((v) => ({ value: v, label: v }));
const TYPE_OPTIONS: FilterOption[] = [
  { value: "debit", label: "debit" },
  { value: "credit", label: "credit" },
  { value: "needs_review", label: "needs review" },
];
const STATUS_OPTIONS: FilterOption[] = [
  "success", "pending", "failed", "revoked",
].map((v) => ({ value: v, label: v }));
const ACCOUNT_TYPE_OPTIONS: FilterOption[] = [
  { value: "savings", label: "savings" },
  { value: "credit_card", label: "credit card" },
  { value: "unknown", label: "unknown" },
];

// Header cell that toggles sort. A plain link, so sorting works without
// client-side JS and every sorted view is a shareable URL.
function SortHeader({
  label,
  column,
  sort,
  dir,
  href,
  className = "",
}: {
  label: string;
  column: SortKey;
  sort: SortKey;
  dir: SortDir;
  href: string;
  className?: string;
}) {
  const active = sort === column;
  return (
    <th scope="col" className={`px-1.5 py-2 font-medium sm:px-3 ${className}`}>
      <Link
        href={href}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
        className={active ? "font-semibold underline underline-offset-2" : ""}
      >
        {label}
        <span aria-hidden className={active ? "" : "text-zinc-300 dark:text-zinc-600"}>
          {active ? (dir === "asc" ? " ▲" : " ▼") : " ↕"}
        </span>
      </Link>
    </th>
  );
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const endTiming = startTiming("GET /transactions");
  try {
    return await renderTransactionsPage(searchParams);
  } finally {
    endTiming();
  }
}

async function renderTransactionsPage(
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
) {
  const params = await searchParams;
  const { filters, sort, dir, page } = parseListState(params);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  const filtered = hasAnyFilter(filters);

  // "estimated" uses Postgres table statistics instead of a real COUNT(*), so
  // it stays fast as the table grows - but it can't reflect a filtered
  // predicate, and a wrong "N matching" beside active filters would be
  // misleading. Exact only when filters are on.
  const countMode = filtered ? "exact" : "estimated";

  let query = supabase
    .from("transactions")
    .select(
      "id, payee, amount, currency, transaction_date, type, payment_method, status, account_type, card_or_account, note, is_transfer, starred, settlement_group_id, settlement_groups(name), categories(name), raw_messages!inner(created_at, phone_received_at)",
      { count: countMode }
    )
    .neq("type", "ignored");

  // AND across columns; OR within a single multi-select.
  if (filters.types.length) query = query.in("type", filters.types);
  if (filters.methods.length) query = query.in("payment_method", filters.methods);
  if (filters.statuses.length) query = query.in("status", filters.statuses);
  if (filters.accountTypes.length) query = query.in("account_type", filters.accountTypes);

  if (filters.categories.length) {
    // "No category" can't be expressed as an id, so it becomes an OR arm.
    const ids = filters.categories.filter((c) => c !== UNCATEGORIZED);
    const wantsNone = filters.categories.includes(UNCATEGORIZED);
    if (wantsNone && ids.length) {
      query = query.or(`category_id.is.null,category_id.in.(${ids.join(",")})`);
    } else if (wantsNone) {
      query = query.is("category_id", null);
    } else {
      query = query.in("category_id", ids);
    }
  }

  const amountMin = parseFloat(filters.amountMin);
  const amountMax = parseFloat(filters.amountMax);
  if (Number.isFinite(amountMin)) query = query.gte("amount", amountMin);
  if (Number.isFinite(amountMax)) query = query.lte("amount", amountMax);

  // Date filtering is on phone_received_at (the receipt anchor used everywhere
  // else in the app) rather than transaction_date, which is null on 37 rows.
  // The !inner join above is what makes this filter the parent rows, not just
  // the embed.
  const fromISO = filters.dateFrom ? istDayStartUtc(filters.dateFrom) : null;
  const toISO = filters.dateTo ? istDayEndUtc(filters.dateTo) : null;
  if (fromISO) query = query.gte("raw_messages.phone_received_at", fromISO);
  if (toISO) query = query.lt("raw_messages.phone_received_at", toISO);

  const payeeTerm = filters.payee.trim();
  if (payeeTerm) {
    // Escape PostgREST's own wildcards so a literal % or _ searches as typed.
    const escaped = payeeTerm.replace(/[%_]/g, (m) => `\\${m}`);
    query = query.ilike("payee", `%${escaped}%`);
  }

  const ascending = dir === "asc";
  query = query
    .order(SORT_COLUMN[sort], { ascending, nullsFirst: false })
    // Stable tiebreak, so equal values don't shuffle between pages.
    .order("id", { ascending: false })
    .range(from, to);

  const [{ data, count, error }, categories] = await Promise.all([
    query.returns<TransactionQueryRow[]>(),
    getAssignableCategories(),
  ]);

  // Fetched before the error branch, which also renders the callout.
  const rejections = await fetchPendingRejections();

  if (error) {
    return (
      <main className="p-4">
        <h1 className="text-xl font-semibold">Transactions</h1>

      <RejectedCaptureCallout rejections={rejections} />
        <p className="mt-4 text-red-600">Failed to load transactions: {error.message}</p>
      </main>
    );
  }

  const rows: RowData[] = (data ?? []).map((r) => ({
    id: r.id,
    payee: r.payee,
    amount: r.amount,
    currency: r.currency,
    transaction_date: r.transaction_date,
    type: r.type,
    payment_method: r.payment_method,
    status: r.status,
    account_type: r.account_type,
    card_or_account: r.card_or_account,
    note: r.note,
    is_transfer: r.is_transfer,
    starred: r.starred,
    categoryName: r.categories?.name ?? null,
    groupName: r.settlement_groups?.name ?? null,
    dateShort: formatReceivedShort(
      r.raw_messages?.phone_received_at ?? null,
      r.raw_messages?.created_at ?? null
    ),
    receivedFull: formatReceived(
      r.raw_messages?.phone_received_at ?? null,
      r.raw_messages?.created_at ?? null
    ),
  }));

  // What the selection panel can offer. Already-grouped rows are listed but not
  // selectable, because a transaction belongs to at most one group and silently
  // moving one would change the other group's total.
  const selectable: SelectableTransaction[] = (data ?? []).map((r) => ({
    id: r.id,
    type: r.type,
    amount: r.amount,
    payee: r.payee,
    groupName: r.settlement_groups?.name ?? null,
  }));

  const total = count ?? 0;
  const hasNext = to < total - 1;
  const hasPrev = page > 1;

  const categoryOptions: FilterOption[] = [
    { value: UNCATEGORIZED, label: "No category" },
    ...categories
      .map((c) => ({ value: String(c.id), label: c.name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];

  // Toggles direction when re-tapping the active column; a new column starts
  // descending, which is the useful default for dates and amounts.
  const sortHref = (column: SortKey) => {
    const nextDir: SortDir = sort === column && dir === "desc" ? "asc" : "desc";
    return `/transactions${buildQuery({ filters, sort: column, dir: nextDir })}`;
  };
  const pageHref = (n: number) =>
    `/transactions${buildQuery({ filters, sort, dir, page: n })}`;

  return (
    <main className="flex flex-col gap-3 p-3 sm:gap-4 sm:p-6">
      <RefreshOnVisible />
      <h1 className="text-xl font-semibold">Transactions</h1>

      <RejectedCaptureCallout rejections={rejections} />

      <TransactionFilters
        initial={filters}
        sort={sort}
        dir={dir}
        categoryOptions={categoryOptions}
        methodOptions={METHOD_OPTIONS}
        typeOptions={TYPE_OPTIONS}
        accountTypeOptions={ACCOUNT_TYPE_OPTIONS}
        statusOptions={STATUS_OPTIONS}
        resultCount={total}
      />

      <GroupSelectionProvider transactions={selectable} categories={categories}>

      {/* table-fixed + explicit widths + truncation is what guarantees the four
          columns fit a phone screen; without it a long payee widens the table
          and reintroduces horizontal scroll. */}
      <div className="rounded border border-zinc-200 dark:border-zinc-800">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[4.2rem] sm:w-28" />
            <col className="w-[5.2rem] sm:w-32" />
            <col className="w-[7.5rem] sm:w-56" />
            <col />
          </colgroup>
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <SortHeader label="Date" column="date" sort={sort} dir={dir} href={sortHref("date")} />
              <SortHeader
                label="Amount"
                column="amount"
                sort={sort}
                dir={dir}
                href={sortHref("amount")}
                className="text-right"
              />
              <SortHeader
                label="Category"
                column="category"
                sort={sort}
                dir={dir}
                href={sortHref("category")}
              />
              <SortHeader
                label="Payee"
                column="payee"
                sort={sort}
                dir={dir}
                href={sortHref("payee")}
              />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <TransactionRow key={row.id} row={row} categories={categories} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-zinc-500">
                  No transactions match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      </GroupSelectionProvider>

      <p className="text-xs text-zinc-400">
        Tap a row for the remaining fields (type, method, status, account, note) and to star it.
        Date is when the message was received, not necessarily the exact transaction moment.
      </p>

      <div className="flex items-center justify-between text-sm">
        <Link
          href={pageHref(page - 1)}
          aria-disabled={!hasPrev}
          className={`rounded border border-zinc-300 px-3 py-1.5 dark:border-zinc-700 ${
            hasPrev ? "hover:bg-zinc-100 dark:hover:bg-zinc-900" : "pointer-events-none opacity-40"
          }`}
        >
          Previous
        </Link>
        <span className="text-zinc-500">Page {page}</span>
        <Link
          href={pageHref(page + 1)}
          aria-disabled={!hasNext}
          className={`rounded border border-zinc-300 px-3 py-1.5 dark:border-zinc-700 ${
            hasNext ? "hover:bg-zinc-100 dark:hover:bg-zinc-900" : "pointer-events-none opacity-40"
          }`}
        >
          Next
        </Link>
      </div>
    </main>
  );
}
