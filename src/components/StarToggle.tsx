"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { setTransactionStarred } from "@/lib/starTransaction";

// Flagging a transaction for review. The column is still called `starred` and
// the glyph is still a star, but the action has one name across the app now:
// it puts the transaction on /review, whose query is exactly "flagged or
// uncategorised". Calling it Star here and Mark for review elsewhere made one
// action look like two.
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
      aria-label={starred ? "Flagged for review - tap to unflag" : "Mark for review"}
      aria-pressed={starred}
      className={`text-lg leading-none disabled:opacity-50 ${
        starred ? "text-amber-500" : "text-zinc-300 hover:text-zinc-400 dark:text-zinc-600 dark:hover:text-zinc-500"
      }`}
    >
      {starred ? "★" : "☆"}
    </button>
  );
}
