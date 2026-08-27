"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CategoryOption } from "@/lib/gemini";

/**
 * Editing a group after the fact: its category, and which transactions are in
 * it.
 *
 * Nothing here recalculates anything by hand. The group's net, whether that net
 * counts as spend, the category the spend is filed under and the reconciliation
 * warning are all derived from the group's current transactions every time they
 * are read - so changing membership changes all of them at once. That is
 * precisely why none of them is stored.
 */
export function GroupEditor({
  groupId,
  categoryId,
  categories,
  members,
  candidates,
}: {
  groupId: number;
  categoryId: number | null;
  categories: CategoryOption[];
  members: { id: number; label: string }[];
  candidates: { id: number; label: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");

  async function call(url: string, method: string, body: unknown) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") throw new Error(json.error ?? "Failed");
      setAdding("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="mt-3 text-[0.75rem] font-medium text-[var(--sk-accent-ink)]">
        Edit group
      </button>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-2xl bg-[var(--sk-plane)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--sk-ink-3)]">
          Edit group
        </span>
        <button type="button" onClick={() => setOpen(false)} className="text-[0.75rem] text-[var(--sk-ink-3)]">
          Done
        </button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[0.75rem] text-[var(--sk-ink-3)]">Category (what the pie shows)</span>
        <select
          value={categoryId ?? ""}
          disabled={pending}
          onChange={(e) =>
            call("/api/settlements", "PATCH", {
              groupId,
              categoryId: e.target.value ? Number(e.target.value) : null,
            })
          }
          className="rounded-xl border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] px-3 py-2 text-sm"
        >
          <option value="">Largest transaction&apos;s category</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.parentName ? `${c.parentName} › ${c.name}` : c.name}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-[0.75rem] text-[var(--sk-ink-3)]">Transactions</span>
        {members.map((m) => (
          <div key={m.id} className="flex items-center gap-2 text-[0.8125rem]">
            <span className="min-w-0 flex-1 truncate text-[var(--sk-ink)]">{m.label}</span>
            <button
              type="button"
              disabled={pending}
              onClick={() => call("/api/settlements/transactions", "DELETE", { transactionId: m.id })}
              className="shrink-0 rounded-full border border-[var(--sk-hair-strong)] px-2.5 py-1 text-[0.6875rem] font-medium text-[var(--sk-ink-2)] disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {candidates.length > 0 && (
        <div className="flex gap-2">
          <select
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            className="min-w-0 flex-1 rounded-xl border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] px-3 py-2 text-sm"
          >
            <option value="">Add a transaction…</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending || !adding}
            onClick={() => call("/api/settlements/transactions", "POST", { groupId, transactionIds: [Number(adding)] })}
            className="shrink-0 rounded-xl border border-[var(--sk-accent-edge)] bg-[var(--sk-accent)] px-3 py-2 text-[0.8125rem] font-semibold text-[var(--sk-accent-on)] disabled:opacity-40"
          >
            Add
          </button>
        </div>
      )}

      <button
        type="button"
        disabled={pending}
        onClick={() => call("/api/settlements", "DELETE", { groupId })}
        className="self-start rounded-full border border-[var(--sk-bad)]/30 px-3 py-1.5 text-[0.75rem] font-medium text-[var(--sk-bad)] disabled:opacity-50"
      >
        Ungroup
      </button>

      {error && <p className="text-[0.75rem] text-[var(--sk-bad)]">{error}</p>}
      <p className="text-[0.6875rem] text-[var(--sk-ink-3)]">
        Removing a transaction returns it to counting on its own. The group&apos;s net, whether it counts as
        spend at all, and the split warning are all recalculated. Ungrouping can be undone.
      </p>
    </div>
  );
}
