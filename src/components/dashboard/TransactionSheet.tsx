"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { DashRow } from "@/lib/dashboard";
import { formatInr } from "@/lib/formatInr";
import { istDateTime } from "@/lib/formatIst";
import { setTransactionStarred } from "@/lib/starTransaction";
import { setTransactionCategory } from "@/lib/setCategory";
import type { CategoryOption } from "@/lib/gemini";

/**
 * The bottom of the drill path: one transaction, in full.
 *
 * The same fields /transactions shows when a row is expanded, so the two
 * screens describe a transaction the same way. Type, status, currency and
 * transfer are deliberately absent - every row that can reach this sheet is a
 * successful non-transfer INR debit by definition of the spend query, so
 * printing them would be four lines that can never say anything else.
 */
export function TransactionSheet({
  row,
  categoryName,
  categories,
  onClose,
}: {
  row: DashRow;
  categoryName: string;
  categories: CategoryOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [starred, setStarred] = useState(row.starred);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState(categoryName);
  const [categoryPending, setCategoryPending] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  async function changeCategory(next: string) {
    if (!next || next === category) return;
    setCategoryPending(true);
    setCategoryError(null);
    try {
      await setTransactionCategory(row.id, next);
      setCategory(next);
      // Correcting a category also clears the review flag server-side, so the
      // sheet's own star has to follow or the two would disagree on screen.
      setStarred(false);
      router.refresh();
    } catch (err) {
      console.error("Failed to change category:", err);
      setCategoryError(err instanceof Error ? err.message : "Couldn't save that.");
    } finally {
      setCategoryPending(false);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function toggleReview() {
    const next = !starred;
    setPending(true);
    setError(null);
    try {
      await setTransactionStarred(row.id, next);
      setStarred(next);
      // The dashboard is server-rendered, so the row's own starred flag only
      // catches up on a refresh - without this the sheet and the data behind
      // it disagree the moment it is reopened.
      router.refresh();
    } catch (err) {
      console.error("Failed to flag transaction for review:", err);
      setError("Couldn't save that. Try again.");
    } finally {
      setPending(false);
    }
  }

  // "Ignore" is an action, not a spending category - pinned to its own group so
  // it does not blend in among real ones, exactly as in CategoryPicker.
  const ignoreOption = categories.find((c) => c.name === "Ignore");
  const grouped = new Map<string, CategoryOption[]>();
  for (const c of categories) {
    if (c.name === "Ignore") continue;
    const key = c.parentName ?? c.name;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(c);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Transaction detail"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-3xl border border-[var(--sk-hair)] bg-[var(--sk-surface)] p-5 pb-8 shadow-[0_-8px_40px_-12px_rgba(28,25,23,0.28)] sm:rounded-3xl sm:pb-5"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-[var(--sk-ink)]">
              {row.payee?.trim() || "Unknown payee"}
            </h2>
            <p className="mt-0.5 text-[0.8125rem] text-[var(--sk-ink-3)]">{category}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[var(--sk-hair-strong)] text-[var(--sk-ink-2)] active:bg-[var(--sk-plane)]"
          >
            ✕
          </button>
        </div>

        <p className="text-[2rem] font-semibold leading-none tracking-tight tabular-nums text-[var(--sk-ink)]">
          {formatInr(row.amount, 2)}
        </p>

        {/* Same correction path as /transactions and /review: it updates the
            transaction and upserts merchant_categories as a manual override, so
            future transactions from this payee inherit it. */}
        <div className="mt-5">
          <label
            htmlFor={`category-${row.id}`}
            className="block text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--sk-ink-3)]"
          >
            Category
          </label>
          <select
            id={`category-${row.id}`}
            value={category}
            disabled={categoryPending}
            onChange={(e) => changeCategory(e.target.value)}
            className="mt-1.5 w-full rounded-xl border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] px-3 py-2.5 text-[0.875rem] text-[var(--sk-ink)] disabled:opacity-60"
          >
            {!categories.some((c) => c.name === category) && (
              <option value={category}>{category}</option>
            )}
            {ignoreOption && (
              <optgroup label="Actions">
                <option value={ignoreOption.name}>Ignore</option>
              </optgroup>
            )}
            {[...grouped.entries()].map(([group, options]) => (
              <optgroup key={group} label={group}>
                {options.map((option) => (
                  <option key={option.id} value={option.name}>
                    {option.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className="mt-1.5 text-[0.6875rem] text-[var(--sk-ink-3)]">
            {categoryError ??
              (categoryPending
                ? "Saving…"
                : row.payee?.trim()
                  ? `Future ${row.payee.trim()} transactions will use this too.`
                  : "This transaction only - no payee to remember it against.")}
          </p>
        </div>

        <dl className="mt-5 flex flex-col gap-2.5 text-[0.8125rem]">
          <Field label="Received" value={istDateTime(Date.parse(row.at))} />
          <Field label="Txn date" value={row.transactionDate} />
          <Field label="Method" value={row.paymentMethod} />
          <Field label="Account type" value={row.accountType} />
          <Field label="Card / account" value={row.cardOrAccount} />
          <Field label="Note" value={row.note} />
        </dl>

        <button
          type="button"
          onClick={toggleReview}
          disabled={pending}
          aria-pressed={starred}
          className={`mt-6 flex w-full items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-[0.875rem] font-semibold transition-colors disabled:opacity-60 ${
            starred
              ? "border-[var(--sk-accent-edge)] bg-[var(--sk-accent)] text-[var(--sk-accent-on)]"
              : "border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] text-[var(--sk-ink-2)] active:bg-[var(--sk-plane)]"
          }`}
        >
          <span aria-hidden>{starred ? "★" : "☆"}</span>
          {starred ? "Flagged for review" : "Mark for review"}
        </button>
        <p className="mt-2 text-center text-[0.6875rem] text-[var(--sk-ink-3)]">
          {error ?? "Flagged transactions appear on the Review screen."}
        </p>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-[var(--sk-ink-3)]">{label}</dt>
      <dd className="min-w-0 break-words text-[var(--sk-ink)]">{value?.trim() || "—"}</dd>
    </div>
  );
}
