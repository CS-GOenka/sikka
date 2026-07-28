"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export type CleanupRow = {
  payee: string;
  txCount: number;
  totalInr: number;
  firstDate: string | null;
  lastDate: string | null;
};

// Person-to-Person cleanup is only ever a Friends-vs-Family split, so the
// picker offers exactly those two. Everything is staged in local state and
// sent in one request when "Save changes" is clicked - rows can be set,
// changed, or reverted freely before committing, and nothing is written until
// the single submit.
export function CleanupTable({
  rows,
  options,
}: {
  rows: CleanupRow[];
  options: string[];
}) {
  const router = useRouter();
  // payee -> chosen category name ("" means "leave as-is")
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changes = useMemo(
    () => Object.entries(selections).filter(([, category]) => category !== ""),
    [selections]
  );

  function setSelection(payee: string, category: string) {
    setSelections((prev) => ({ ...prev, [payee]: category }));
  }

  async function handleSave() {
    if (changes.length === 0) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/cleanup/recategorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes: changes.map(([payee, category]) => ({ payee, category })) }),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") {
        throw new Error(json.error ?? "Failed to save changes");
      }
      // Saved payees move to a real leaf category and drop off this queue on
      // refresh, so clear the staged selections too.
      setSelections({});
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save changes");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={pending || changes.length === 0}
          className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {pending ? "Saving…" : `Save ${changes.length} change${changes.length === 1 ? "" : "s"}`}
        </button>
        {changes.length > 0 && !pending && (
          <button
            type="button"
            onClick={() => setSelections({})}
            className="text-sm text-zinc-500 underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            Revert all
          </button>
        )}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>

      <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
        <table className="min-w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 font-medium">Payee</th>
              <th className="px-3 py-2 font-medium">Tx count</th>
              <th className="px-3 py-2 font-medium">Total ₹</th>
              <th className="px-3 py-2 font-medium">First</th>
              <th className="px-3 py-2 font-medium">Last</th>
              <th className="px-3 py-2 font-medium">Category</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const selected = selections[row.payee] ?? "";
              return (
                <tr
                  key={row.payee}
                  className={`border-t border-zinc-200 dark:border-zinc-800 ${
                    selected ? "bg-amber-50 dark:bg-amber-950/30" : ""
                  }`}
                >
                  <td className="px-3 py-2">{row.payee}</td>
                  <td className="px-3 py-2 text-zinc-500">{row.txCount}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-medium">
                    {row.totalInr.toLocaleString("en-IN")}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-zinc-500">{row.firstDate ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-zinc-500">{row.lastDate ?? "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      {options.map((name) => {
                        const active = selected === name;
                        return (
                          <button
                            key={name}
                            type="button"
                            onClick={() => setSelection(row.payee, active ? "" : name)}
                            disabled={pending}
                            aria-pressed={active}
                            className={`rounded border px-2 py-1 text-xs disabled:opacity-50 ${
                              active
                                ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                                : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            }`}
                          >
                            {name}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                  Nothing left to clean up.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
