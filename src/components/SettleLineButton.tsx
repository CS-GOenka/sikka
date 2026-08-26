"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Marks one person's line settled, or puts it back. */
export function SettleLineButton({ lineId, settled }: { lineId: number; settled: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function toggle() {
    setPending(true);
    try {
      const res = await fetch("/api/settlements/lines", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineId, settled: !settled }),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") throw new Error(json.error ?? "Failed");
      // Settling the last line closes the group and changes the owed total on
      // the homepage, so the whole tree has to re-read.
      router.refresh();
    } catch (err) {
      console.error("Failed to settle line:", err);
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={settled}
      className={`shrink-0 rounded-full border px-3 py-1.5 text-[0.75rem] font-semibold transition-colors disabled:opacity-50 ${
        settled
          ? "border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] text-[var(--sk-ink-3)]"
          : "border-[var(--sk-accent-edge)] bg-[var(--sk-accent)] text-[var(--sk-accent-on)]"
      }`}
    >
      {settled ? "Settled ✓" : "Mark settled"}
    </button>
  );
}
