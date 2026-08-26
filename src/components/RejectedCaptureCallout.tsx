"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatInr } from "@/lib/formatInr";
import type { RejectedCapture } from "@/lib/rejectedCaptures";

/**
 * A share the ingest refused, put in front of the user.
 *
 * Red, and phrased as a question rather than a notice. Something was shared by
 * hand and did not arrive - which is the one case where staying quiet is worse
 * than interrupting, because nobody re-checks a transaction they believe was
 * captured.
 */
export function RejectedCaptureCallout({ rejections }: { rejections: RejectedCapture[] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (rejections.length === 0) return null;

  async function answer(id: number, action: "capture" | "duplicate") {
    setPendingId(id);
    setError(null);
    try {
      const res = await fetch("/api/rejected-captures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") throw new Error(json.error ?? "Failed");
      router.refresh();
    } catch (err) {
      console.error("Failed to answer rejected capture:", err);
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPendingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[var(--sk-bad)]/30 bg-[var(--sk-bad-tint)] p-4">
      <div className="flex items-start gap-2.5">
        <svg viewBox="0 0 16 16" aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--sk-bad)]">
          <path d="M8 2.5l6 11H2l6-11z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M8 6.5v3.2M8 11.6v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <p className="text-[0.875rem] font-semibold text-[var(--sk-bad)]">
          {rejections.length === 1
            ? "A shared transaction wasn't captured"
            : `${rejections.length} shared transactions weren't captured`}
        </p>
      </div>

      <ul className="flex flex-col gap-3">
        {rejections.map((r) => (
          <li key={r.id} className="rounded-xl bg-[var(--sk-surface)] p-3">
            <p className="text-[0.875rem] font-semibold text-[var(--sk-ink)]">
              {r.amount != null ? formatInr(r.amount) : "Unknown amount"}
              {r.payee ? ` · ${r.payee}` : ""}
            </p>
            <p className="mt-0.5 text-[0.75rem] text-[var(--sk-ink-3)]">
              {r.transactionDate ? `${r.transactionDate} · ` : ""}
              looked like a duplicate ({r.reason})
            </p>
            <div className="mt-2.5 flex gap-2">
              <button
                type="button"
                disabled={pendingId === r.id}
                onClick={() => answer(r.id, "capture")}
                className="flex-1 rounded-xl border border-[var(--sk-accent-edge)] bg-[var(--sk-accent)] py-2 text-[0.8125rem] font-semibold text-[var(--sk-accent-on)] disabled:opacity-50"
              >
                {pendingId === r.id ? "…" : "It's separate — capture it"}
              </button>
              <button
                type="button"
                disabled={pendingId === r.id}
                onClick={() => answer(r.id, "duplicate")}
                className="flex-1 rounded-xl border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] py-2 text-[0.8125rem] font-medium text-[var(--sk-ink-2)] disabled:opacity-50"
              >
                It&apos;s a duplicate
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="text-[0.75rem] text-[var(--sk-bad)]">{error}</p>}
    </div>
  );
}
