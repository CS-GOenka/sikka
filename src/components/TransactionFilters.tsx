"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  type TransactionFilters as Filters,
  type SortKey,
  type SortDir,
  EMPTY_FILTERS,
  UNCATEGORIZED,
  activeFilterCount,
  buildQuery,
} from "@/lib/transactionQuery";

export type FilterOption = { value: string; label: string };

const box =
  "rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

// One collapsible panel rather than a control per column header: at phone
// width, per-column controls would either wrap the header row or reintroduce
// the horizontal scrolling this page is meant to remove.
function Group({
  label,
  options,
  selected,
  onToggle,
  scroll,
}: {
  label: string;
  options: FilterOption[];
  selected: string[];
  onToggle: (value: string) => void;
  scroll?: boolean;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</legend>
      <div
        className={`mt-1 flex flex-wrap gap-x-3 gap-y-1 ${
          scroll ? "max-h-36 overflow-y-auto rounded border border-zinc-200 p-2 dark:border-zinc-800" : ""
        }`}
      >
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(o.value)}
              onChange={() => onToggle(o.value)}
            />
            <span className="truncate">{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function TransactionFilters({
  initial,
  sort,
  dir,
  categoryOptions,
  methodOptions,
  typeOptions,
  accountTypeOptions,
  statusOptions,
  resultCount,
}: {
  initial: Filters;
  sort: SortKey;
  dir: SortDir;
  categoryOptions: FilterOption[];
  methodOptions: FilterOption[];
  typeOptions: FilterOption[];
  accountTypeOptions: FilterOption[];
  statusOptions: FilterOption[];
  resultCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Filters>(initial);

  // Resync when the URL changes underneath us (back button, Reset, a link
  // elsewhere). Adjusting state during render is React's documented pattern
  // for this - an effect would fire a second render pass every time.
  //
  // Compared by value, not reference: this is a server component's prop, so a
  // fresh object arrives on every re-render, and router.refresh() runs on each
  // category edit. Reference comparison would wipe half-typed input.
  const initialKey = JSON.stringify(initial);
  const [syncedKey, setSyncedKey] = useState(initialKey);
  if (initialKey !== syncedKey) {
    setSyncedKey(initialKey);
    setDraft(initial);
  }

  // Sort is preserved across filter changes; page is not - a filtered list is
  // a different list, so staying on page 7 would usually land on nothing.
  const push = (next: Filters) => {
    router.push(`/transactions${buildQuery({ filters: next, sort, dir })}`);
  };

  // Text input is debounced so the list still updates as you type without
  // firing a server round trip per keystroke.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setPayee = (value: string) => {
    setDraft((d) => ({ ...d, payee: value }));
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      setDraft((d) => {
        push({ ...d, payee: value });
        return d;
      });
    }, 350);
  };

  const toggle = (key: keyof Filters, value: string) => {
    const current = draft[key] as string[];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    const updated = { ...draft, [key]: next };
    setDraft(updated);
    push(updated);
  };

  const setField = (key: keyof Filters, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const applyField = (key: keyof Filters, value: string) => {
    const updated = { ...draft, [key]: value };
    setDraft(updated);
    push(updated);
  };

  const count = activeFilterCount(draft);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium dark:border-zinc-700"
        >
          Filters{count > 0 ? ` (${count})` : ""} {open ? "▲" : "▼"}
        </button>
        {count > 0 && (
          <button
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              router.push(`/transactions${buildQuery({ filters: EMPTY_FILTERS, sort, dir })}`);
            }}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
          >
            Reset filters
          </button>
        )}
        <span className="text-sm text-zinc-500">{resultCount} matching</span>
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-4 rounded border border-zinc-200 p-3 dark:border-zinc-800">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Payee contains
            </span>
            <input
              type="search"
              className={box}
              placeholder="e.g. swiggy"
              value={draft.payee}
              onChange={(e) => setPayee(e.target.value)}
            />
          </label>

          <Group
            label="Category"
            options={categoryOptions}
            selected={draft.categories}
            onToggle={(v) => toggle("categories", v)}
            scroll
          />

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Amount</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                inputMode="decimal"
                className={`${box} w-28`}
                placeholder="min"
                value={draft.amountMin}
                onChange={(e) => setField("amountMin", e.target.value)}
                onBlur={(e) => applyField("amountMin", e.target.value)}
              />
              <span className="text-zinc-400">to</span>
              <input
                type="number"
                inputMode="decimal"
                className={`${box} w-28`}
                placeholder="max"
                value={draft.amountMax}
                onChange={(e) => setField("amountMax", e.target.value)}
                onBlur={(e) => applyField("amountMax", e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Date</span>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                className={box}
                value={draft.dateFrom}
                onChange={(e) => applyField("dateFrom", e.target.value)}
              />
              <span className="text-zinc-400">to</span>
              <input
                type="date"
                className={box}
                value={draft.dateTo}
                onChange={(e) => applyField("dateTo", e.target.value)}
              />
            </div>
          </div>

          <Group
            label="Type"
            options={typeOptions}
            selected={draft.types}
            onToggle={(v) => toggle("types", v)}
          />
          <Group
            label="Payment method"
            options={methodOptions}
            selected={draft.methods}
            onToggle={(v) => toggle("methods", v)}
          />
          <Group
            label="Status"
            options={statusOptions}
            selected={draft.statuses}
            onToggle={(v) => toggle("statuses", v)}
          />
          <Group
            label="Account type"
            options={accountTypeOptions}
            selected={draft.accountTypes}
            onToggle={(v) => toggle("accountTypes", v)}
          />

          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            Filters combine with AND across columns; multiple values within one filter match any of
            them. &ldquo;{categoryOptions.find((o) => o.value === UNCATEGORIZED)?.label ?? "No category"}
            &rdquo; matches transactions with no category set.
          </p>
        </div>
      )}
    </div>
  );
}
