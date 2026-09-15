"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * The per-row overflow menu on the groups list.
 *
 * Only the two things worth doing without opening the group: going in to edit
 * it, and ungrouping it. Everything else - settling, the breakdown, the
 * arithmetic - lives on the group's own screen, because those need room and
 * because a settle button in a list is a destructive tap sitting exactly where
 * the finger lands to open the row.
 */
export function GroupRowMenu({ groupId, groupLabel }: { groupId: number; groupLabel: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function ungroup() {
    setPending(true);
    try {
      const res = await fetch("/api/settlements", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId }),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") throw new Error(json.error ?? "Failed");
      setOpen(false);
      router.refresh();
    } catch (err) {
      console.error("Failed to ungroup:", err);
    } finally {
      setPending(false);
    }
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={`Actions for ${groupLabel}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}
        className="flex size-11 items-center justify-center rounded-full text-[var(--sk-ink-3)] active:bg-[var(--sk-plane)]"
      >
        <span aria-hidden className="text-lg leading-none">⋯</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-20 w-44 overflow-hidden rounded-2xl border border-[var(--sk-hair)] bg-[var(--sk-surface)] shadow-[0_8px_28px_-10px_rgba(28,25,23,0.35)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); router.push(`/groups/${groupId}?edit=1`); }}
            className="flex min-h-11 w-full items-center px-4 text-left text-[0.875rem] text-[var(--sk-ink)] active:bg-[var(--sk-plane)]"
          >
            Edit group
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={pending}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); ungroup(); }}
            className="flex min-h-11 w-full items-center border-t border-[var(--sk-hair)] px-4 text-left text-[0.875rem] text-[var(--sk-bad)] active:bg-[var(--sk-plane)] disabled:opacity-50"
          >
            {pending ? "Ungrouping…" : "Ungroup"}
          </button>
        </div>
      )}
    </div>
  );
}
