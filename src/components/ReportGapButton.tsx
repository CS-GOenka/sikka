"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Reports a suspected classifier gap. The comment is optional - submitting
// with it empty is fine. This removes the row from /review but does not
// mark it resolved (see /api/classifier-gaps/report).
export function ReportGapButton({ transactionId }: { transactionId: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/classifier-gaps/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId, comment: comment.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") {
        throw new Error(json.error ?? "Failed to report");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to report");
      setPending(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-left text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        Report incorrect classification
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Optional: what's wrong? (not required)"
        rows={2}
        disabled={pending}
        className="w-full max-w-xs rounded border border-zinc-300 bg-white px-2 py-1 text-xs disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={handleSubmit}
          disabled={pending}
          className="rounded bg-zinc-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {pending ? "Submitting…" : "Submit report"}
        </button>
        <button
          onClick={() => setOpen(false)}
          disabled={pending}
          className="text-xs text-zinc-500 hover:text-zinc-700 disabled:opacity-50 dark:hover:text-zinc-300"
        >
          Cancel
        </button>
      </div>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
