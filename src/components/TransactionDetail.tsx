"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatInr } from "@/lib/formatInr";
import { setTransactionCategory } from "@/lib/setCategory";
import { setTransactionStarred } from "@/lib/starTransaction";
import type { CategoryOption } from "@/lib/gemini";
import type { TxnDetail } from "@/lib/txnDetail";

const UNCATEGORISED = "Uncategorized";

/**
 * One transaction, in full - the only place either screen describes one.
 *
 * Presented as a sheet from both entry points. The transactions list used to
 * expand a row in place instead, which meant the same transaction had two
 * layouts, two field sets and two names for the same button depending on how
 * you got to it.
 *
 * On "Mark for review": starring a transaction and marking it for review were
 * always the same act - one column, one endpoint - but the list called it Star
 * and the dashboard called it Mark for review, so the app appeared to offer two
 * things that did the same thing. It is named once here, after what it does:
 * /review shows exactly the transactions that are flagged or uncategorised.
 */
export function TransactionDetail({
  txn,
  categories,
  onClose,
  showJumpToTransactions = false,
}: {
  txn: TxnDetail;
  categories: CategoryOption[];
  onClose: () => void;
  /** Hidden when this already IS the transactions screen - it would go nowhere. */
  showJumpToTransactions?: boolean;
}) {
  const router = useRouter();
  const [starred, setStarred] = useState(txn.starred);
  const [category, setCategory] = useState(txn.categoryName ?? UNCATEGORISED);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categoryPending, setCategoryPending] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function changeCategory(next: string) {
    if (!next || next === category) return;
    setCategoryPending(true);
    setCategoryError(null);
    try {
      await setTransactionCategory(txn.id, next);
      setCategory(next);
      // The server clears the review flag as part of recategorising, so the
      // button here has to follow or the two would disagree on screen.
      setStarred(false);
      router.refresh();
    } catch (err) {
      console.error("Failed to change category:", err);
      setCategoryError(err instanceof Error ? err.message : "Couldn't save that.");
    } finally {
      setCategoryPending(false);
    }
  }

  async function toggleReview() {
    const next = !starred;
    setPending(true);
    setError(null);
    try {
      await setTransactionStarred(txn.id, next);
      setStarred(next);
      router.refresh();
    } catch (err) {
      console.error("Failed to flag transaction for review:", err);
      setError("Couldn't save that. Try again.");
    } finally {
      setPending(false);
    }
  }

  // "Ignore" is an action, not a spending category, so it is pinned to its own
  // group rather than blending in among real ones - as in CategoryPicker.
  const ignoreOption = categories.find((c) => c.name === "Ignore");
  const grouped = new Map<string, CategoryOption[]>();
  for (const c of categories) {
    if (c.name === "Ignore") continue;
    const key = c.parentName ?? c.name;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(c);
  }

  const amount =
    txn.amount == null
      ? "—"
      : `${txn.type === "credit" ? "+" : txn.type === "debit" ? "−" : ""}${
          txn.currency === "INR" ? formatInr(Math.abs(txn.amount)) : `${txn.currency} ${Math.abs(txn.amount).toFixed(2)}`
        }`;

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
              {txn.payee?.trim() || "Unknown payee"}
            </h2>
            <p className="mt-0.5 text-[0.8125rem] text-[var(--sk-ink-3)]">{category}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-11 shrink-0 items-center justify-center rounded-full border border-[var(--sk-hair-strong)] text-[var(--sk-ink-2)] active:bg-[var(--sk-plane)]"
          >
            ✕
          </button>
        </div>

        <p className="text-[2rem] font-semibold leading-none tracking-tight tabular-nums text-[var(--sk-ink)]">
          {amount}
        </p>

        {/* The same correction path as /review: it updates the transaction and
            upserts merchant_categories as a manual override, so future
            transactions from this payee inherit it. */}
        <div className="mt-5">
          <label
            htmlFor={`category-${txn.id}`}
            className="block text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--sk-ink-3)]"
          >
            Category
          </label>
          <select
            id={`category-${txn.id}`}
            value={category}
            disabled={categoryPending}
            onChange={(e) => changeCategory(e.target.value)}
            className="mt-1.5 min-h-11 w-full rounded-xl border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] px-3 py-2.5 text-[0.875rem] text-[var(--sk-ink)] disabled:opacity-60"
          >
            {!categories.some((c) => c.name === category) && <option value={category}>{category}</option>}
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
                : txn.payee?.trim()
                  ? `Future ${txn.payee.trim()} transactions will use this too.`
                  : "This transaction only - no payee to remember it against.")}
          </p>
        </div>

        <dl className="mt-5 flex flex-col gap-2.5 text-[0.8125rem]">
          <Field label="Received" value={txn.receivedFull} />
          <Field label="Txn date" value={txn.transactionDate} />
          <Field label="Type" value={txn.type} />
          <Field label="Method" value={txn.paymentMethod} />
          <Field label="Status" value={txn.status} />
          <Field label="Account type" value={txn.accountType} />
          <Field label="Card / account" value={txn.cardOrAccount} />
          <Field label="Transfer" value={txn.isTransfer ? "yes — excluded from spend" : "no"} />
          <Field label="Note" value={txn.note} />
          <Field
            label="Group"
            value={txn.groupName ? `${txn.groupName} — counted through the group's net, not on its own` : null}
          />
        </dl>

        <button
          type="button"
          onClick={toggleReview}
          disabled={pending}
          aria-pressed={starred}
          className={`mt-6 flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-[0.875rem] font-semibold transition-colors disabled:opacity-60 ${
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

        {showJumpToTransactions && (
          <button
            type="button"
            onClick={() => router.push(`/transactions?focus=${txn.id}`)}
            className="mt-3 flex min-h-11 w-full items-center justify-center rounded-2xl border border-[var(--sk-hair-strong)] px-4 py-3 text-[0.875rem] font-medium text-[var(--sk-accent-ink)] active:bg-[var(--sk-plane)]"
          >
            Open in Transactions →
          </button>
        )}
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
