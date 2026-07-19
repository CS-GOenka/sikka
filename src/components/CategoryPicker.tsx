"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CategoryOption } from "@/lib/gemini";

// Shared by /transactions and /review - both use this exact component and
// the same /api/categorize/review endpoint, so there is only ever one code
// path for correcting a transaction's category.
export function CategoryPicker({
  transactionId,
  currentCategoryName,
  categories,
}: {
  transactionId: number;
  currentCategoryName: string | null;
  categories: CategoryOption[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grouped = new Map<string, CategoryOption[]>();
  for (const category of categories) {
    const key = category.parentName ?? category.name;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(category);
  }

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const category = e.target.value;
    if (!category || category === currentCategoryName) return;

    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/categorize/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId, category }),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") {
        throw new Error(json.error ?? "Failed to save category");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save category");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
        value={currentCategoryName ?? ""}
        disabled={pending}
        onChange={handleChange}
      >
        <option value="" disabled>
          {currentCategoryName ?? "Uncategorized"}
        </option>
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
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
