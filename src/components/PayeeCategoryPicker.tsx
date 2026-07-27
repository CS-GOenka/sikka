"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CategoryOption } from "@/lib/gemini";

// Payee-scoped picker for /cleanup - selecting a category here updates
// merchant_categories AND every existing transaction from this payee in one
// action (via /api/cleanup/recategorize), unlike CategoryPicker which is
// scoped to a single transaction.
export function PayeeCategoryPicker({ payee, categories }: { payee: string; categories: CategoryOption[] }) {
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
    if (!category) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/cleanup/recategorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payee, category }),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") {
        throw new Error(json.error ?? "Failed to recategorize");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to recategorize");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
        value=""
        disabled={pending}
        onChange={handleChange}
      >
        <option value="" disabled>
          Choose category…
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
      {pending && <span className="text-xs text-zinc-400">Updating…</span>}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
