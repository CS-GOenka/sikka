import Link from "next/link";
import { formatInr } from "@/lib/formatInr";

/**
 * What people owe me, on the homepage.
 *
 * Sits beside the uncategorised callout and borrows its shape deliberately -
 * one line, a value, somewhere to go. It does not escalate with size the way
 * that one does: money owed is a fact to keep in view, not a mess to clean up,
 * and turning it red for being large would nag about something that is often
 * perfectly fine.
 */
export function OwedCallout({ owed, openGroups }: { owed: number; openGroups: number }) {
  if (owed <= 0) return null;
  return (
    <Link
      href="/groups"
      className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--sk-accent-edge)] bg-[var(--sk-accent-tint)] px-4 py-3 transition-colors active:brightness-97"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0 text-[var(--sk-accent-ink)]">
          <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.6 6.2h4.8M5.6 8.2h4.8M6.4 6.2c2 0 2.6 4 -0.6 4l3 2.6" fill="none"
            stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="min-w-0 truncate text-[0.875rem] text-[var(--sk-ink)]">
          <span className="font-semibold tabular-nums">{formatInr(owed)}</span> owed to you
          <span className="text-[var(--sk-ink-3)]">
            {" "}across {openGroups} {openGroups === 1 ? "settlement" : "settlements"}
          </span>
        </span>
      </span>
      <span className="shrink-0 text-[0.75rem] font-medium text-[var(--sk-accent-ink)]">Settle →</span>
    </Link>
  );
}
