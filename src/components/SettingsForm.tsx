"use client";

import { useState } from "react";

export function SettingsForm({ initialDailyBudget }: { initialDailyBudget: number | null }) {
  const [value, setValue] = useState(initialDailyBudget?.toString() ?? "");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const dailyBudget = Number(value);
    if (!Number.isFinite(dailyBudget) || dailyBudget < 0) {
      setStatus("error");
      setError("Enter a non-negative number");
      return;
    }

    setPending(true);
    setStatus("idle");
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dailyBudget }),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") {
        throw new Error(json.error ?? "Failed to save");
      }
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="daily-budget" className="text-sm font-medium">
        Daily budget
      </label>
      <div className="flex items-center gap-2">
        <input
          id="daily-budget"
          type="number"
          min={0}
          step="0.01"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setStatus("idle");
          }}
          className="w-40 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          onClick={handleSave}
          disabled={pending}
          className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      {status === "saved" && <span className="text-xs text-emerald-600">Saved.</span>}
      {status === "error" && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
