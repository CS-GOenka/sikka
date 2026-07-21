"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function UndoGapButton({ transactionId }: { transactionId: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    try {
      const res = await fetch("/api/classifier-gaps/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId }),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") {
        throw new Error(json.error ?? "Failed to undo");
      }
      router.refresh();
    } catch (err) {
      console.error("Failed to undo classifier gap report:", err);
      setPending(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={pending}
      className="self-start text-xs text-zinc-500 underline hover:text-zinc-700 disabled:opacity-50 dark:hover:text-zinc-300"
    >
      {pending ? "Undoing…" : "Undo report"}
    </button>
  );
}
