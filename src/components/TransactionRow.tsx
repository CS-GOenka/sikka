"use client";

import { useState } from "react";
import { CategoryPicker } from "@/components/CategoryPicker";
import { StarToggle } from "@/components/StarToggle";
import type { CategoryOption } from "@/lib/gemini";

export type RowData = {
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
  categoryName: string | null;
  /** Name of the settlement group this belongs to, when it is a daughter of one. */
  groupName: string | null;
  dateShort: string;
  receivedFull: string;
};

// Compact amount for the phone-width column: the currency code is dropped for
// INR (which is all but a handful of rows) because "−₹1,874" fits where
// "-INR 1,874" does not. Non-INR keeps its code so it can't be misread.
function formatAmountCompact(amount: number | null, currency: string, type: string): string {
  if (amount === null) return "—";
  const sign = type === "debit" ? "−" : type === "credit" ? "+" : "";
  const n = amount.toLocaleString("en-IN");
  return currency === "INR" ? `${sign}₹${n}` : `${sign}${currency} ${n}`;
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex gap-2">
      <span className="w-28 shrink-0 text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
}

export function TransactionRow({
  row,
  categories,
}: {
  row: RowData;
  categories: CategoryOption[];
}) {
  const [open, setOpen] = useState(false);

  const amountClass =
    row.type === "credit"
      ? "text-emerald-600"
      : row.type === "debit"
        ? "text-zinc-900 dark:text-zinc-100"
        : "text-zinc-500";

  return (
    <>
      <tr
        className="cursor-pointer border-t border-zinc-200 align-top dark:border-zinc-800"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <td className="px-1.5 py-2 text-xs text-zinc-500 sm:px-3 sm:text-sm">
          <span className="whitespace-nowrap">{row.dateShort}</span>
          {row.starred && <span className="ml-0.5 text-amber-500">★</span>}
          {/* A daughter of a settlement group. It is still real and still
              listed, but it no longer counts on its own - only its group's net
              does - so it has to look different from a row that does count. */}
          {row.groupName && (
            <span
              title={`Grouped in "${row.groupName}" — counted through the group, not on its own`}
              className="ml-0.5 text-[var(--sk-accent-ink)]"
              aria-label={`Grouped in ${row.groupName}`}
            >
              ⛓
            </span>
          )}
        </td>
        <td
          className={`px-1.5 py-2 text-right text-xs font-medium tabular-nums sm:px-3 sm:text-sm ${amountClass}`}
        >
          <span className="whitespace-nowrap">
            {formatAmountCompact(row.amount, row.currency, row.type)}
          </span>
        </td>
        {/* Interactive cell: clicks here must not also toggle the row. */}
        <td
          className="px-1.5 py-2 sm:px-3"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {row.is_transfer ? (
            <span
              className="inline-block truncate rounded bg-zinc-100 px-1.5 py-1 text-[10px] font-medium text-zinc-500 sm:text-xs dark:bg-zinc-800 dark:text-zinc-400"
              title="Transfer (e.g. credit-card bill payment) — excluded from spend"
            >
              Transfer
            </span>
          ) : (
            <CategoryPicker
              transactionId={row.id}
              currentCategoryName={row.categoryName}
              categories={categories}
              compact
            />
          )}
        </td>
        <td className="px-1.5 py-2 text-xs sm:px-3 sm:text-sm">
          <div className="flex items-center gap-1">
            <span className="min-w-0 truncate" title={row.payee ?? undefined}>
              {row.payee ?? "—"}
            </span>
            <span className="shrink-0 text-zinc-400">{open ? "▴" : "▾"}</span>
          </div>
        </td>
      </tr>
      {open && (
        <tr className="border-t border-zinc-100 bg-zinc-50 dark:border-zinc-900 dark:bg-zinc-900/50">
          {/* The remaining columns live here rather than in the table, so they
              can never push the four core columns off a phone screen. */}
          <td colSpan={4} className="px-3 py-2 text-xs">
            <div className="flex flex-col gap-1">
              <Detail label="Received" value={row.receivedFull} />
              <Detail label="Txn date" value={row.transaction_date ?? "—"} />
              <Detail label="Type" value={row.type} />
              <Detail label="Method" value={row.payment_method} />
              <Detail label="Status" value={row.status ?? "—"} />
              <Detail label="Account type" value={row.account_type ?? "—"} />
              <Detail label="Card/account" value={row.card_or_account ?? "—"} />
              <Detail label="Transfer" value={row.is_transfer ? "yes — excluded from spend" : "no"} />
              <Detail label="Note" value={row.note ?? "—"} />
              <Detail
                label="Group"
                value={
                  row.groupName
                    ? `${row.groupName} — counted through the group's net, not on its own`
                    : "—"
                }
              />
              <div className="flex items-center gap-2 pt-1">
                <span className="w-28 shrink-0 text-zinc-500 dark:text-zinc-400">Star</span>
                <StarToggle transactionId={row.id} starred={row.starred} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
