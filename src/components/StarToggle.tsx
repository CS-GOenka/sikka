"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { setTransactionStarred } from "@/lib/starTransaction";

// Starring surfaces a transaction on /review immediately - no separate
// step, since /review's query includes starred=true directly.
export function StarToggle({ transactionId, starred }: { transactionId: number; starred: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    try {
      await setTransactionStarred(transactionId, !starred);
      router.refresh();
    } catch (err) {
      console.error("Failed to toggle star:", err);
      setPending(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={pending}
      aria-label={starred ? "Unstar" : "Star"}
      aria-pressed={starred}
      className={`text-lg leading-none disabled:opacity-50 ${
        starred ? "text-amber-500" : "text-zinc-300 hover:text-zinc-400 dark:text-zinc-600 dark:hover:text-zinc-500"
      }`}
    >
      {starred ? "★" : "☆"}
    </button>
  );
}
