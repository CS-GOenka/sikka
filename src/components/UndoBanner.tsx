"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { UndoEntry } from "@/lib/settlementUndo";

/**
 * The last settlement action, offered back.
 *
 * Only one at a time. A stack would let undos be applied out of order -
 * reversing an ungroup after a line inside it had been settled - and each
 * would then be restoring a state that no longer exists.
 */
export function UndoBanner({ entry }: { entry: UndoEntry | null }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!entry) return null;

  async function undo() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/settlements/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry!.id }),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") throw new Error(json.error ?? "Failed to undo");
      // Spend totals, the owed callout and the group's status are all derived
      // on read, so refreshing the tree is what puts every number back.
      router.refresh();
    } catch (err) {
      console.error("Undo failed:", err);
      setError(err instanceof Error ? err.message : "Couldn't undo that");
      setPending(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] px-4 py-2.5">
      <span className="min-w-0 truncate text-[0.8125rem] text-[var(--sk-ink-2)]">
        {error ?? entry.label}
      </span>
      <button
        type="button"
        onClick={undo}
        disabled={pending}
        className="shrink-0 rounded-full border border-[var(--sk-accent-edge)] bg-[var(--sk-accent)] px-3.5 py-1.5 text-[0.8125rem] font-semibold text-[var(--sk-accent-on)] disabled:opacity-50"
      >
        {pending ? "Undoing…" : "Undo"}
      </button>
    </div>
  );
}
