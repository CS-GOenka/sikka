"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CategoryOption } from "@/lib/gemini";
import { setTransactionCategory } from "@/lib/setCategory";

// Shared by /transactions and /review - both use this exact component and
// the same /api/categorize/review endpoint, so there is only ever one code
// path for correcting a transaction's category.
export function CategoryPicker({
  transactionId,
  currentCategoryName,
  categories,
  compact = false,
}: {
  transactionId: number;
  currentCategoryName: string | null;
  categories: CategoryOption[];
  // Narrow variant for the /transactions table, where this has to share a
  // phone screen with three other columns.
  compact?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What this picker should show once the save has landed, ahead of the server
  // sending the page back. Null means "whatever the server last said".
  const [saved, setSaved] = useState<string | null>(null);
  const shown = saved ?? currentCategoryName;

  // "Ignore" is an action (dismiss from the review queue), not a spending
  // category - kept out of the alphabetical group list and pinned to its
  // own group at the top instead, so it doesn't blend in among real
  // categories.
  const ignoreOption = categories.find((category) => category.name === "Ignore");
  const spendCategories = categories.filter((category) => category.name !== "Ignore");

  const grouped = new Map<string, CategoryOption[]>();
  for (const category of spendCategories) {
    const key = category.parentName ?? category.name;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(category);
  }

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const category = e.target.value;
    if (!category || category === shown) return;

    setPending(true);
    setError(null);
    try {
      await setTransactionCategory(transactionId, category);
      // The write is what the user is waiting on; the refresh is not. It used
      // to be both: `pending` was only ever cleared on the error path, so the
      // control stayed disabled and read "Saving…" until a full re-render of
      // the page came back - a second server round trip, and on /transactions
      // a re-fetch of all fifty rows to change one cell.
      //
      // So the picker settles on the saved value straight away and the refresh
      // runs behind it. It is still needed: /review drops a row out of the
      // queue once it is categorised, and the dashboard's totals move.
      setSaved(category);
      setPending(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save category");
      setSaved(null);
      setPending(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <select
          className={`w-full min-w-0 rounded border border-zinc-300 bg-white disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 ${
            compact ? "px-1 py-1 text-[11px] sm:text-xs" : "px-2 py-1 text-sm"
          }`}
          value={shown ?? ""}
          disabled={pending}
          onChange={handleChange}
        >
          <option value="" disabled>
            {shown ?? "Uncategorized"}
          </option>
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
        {pending && (
          <span className="shrink-0 text-xs text-zinc-400">{compact ? "…" : "Saving…"}</span>
        )}
      </div>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
