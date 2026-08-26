"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { GroupSelectionContext } from "@/components/GroupSelectionContext";
import { formatInr } from "@/lib/formatInr";
import type { CategoryOption } from "@/lib/gemini";

export interface SelectableTransaction {
  id: number;
  type: string;
  amount: number | null;
  payee: string | null;
  groupName: string | null;
}

interface LineDraft {
  person: string;
  share: string;
}

/**
 * Selecting rows in the transactions table and turning them into a group.
 *
 * Wraps the toolbar and the table so both see one selection. The configuration
 * step opens as a sheet over the list rather than a separate screen, so the
 * rows that were picked stay in view while the split is written.
 */
export function GroupSelectionProvider({
  transactions,
  categories,
  children,
}: {
  transactions: SelectableTransaction[];
  /** Assignable leaves, for the parent's own category. */
  categories: CategoryOption[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  // Selection is always available - a row click selects - so there is no mode
  // to turn on. The toolbar appears once something is picked.
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [configuring, setConfiguring] = useState(false);
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byId = useMemo(() => new Map(transactions.map((t) => [t.id, t])), [transactions]);

  // Debits out, credits back in - the figure the group's spend is measured
  // from. Shown live so a split can be checked while it is typed.
  const gross = useMemo(() => {
    let total = 0;
    for (const id of selected) {
      const t = byId.get(id);
      if (!t || typeof t.amount !== "number") continue;
      if (t.type === "debit") total += t.amount;
      else if (t.type === "credit") total -= t.amount;
    }
    return Math.round((total + Number.EPSILON) * 100) / 100;
  }, [selected, byId]);

  const sharesTotal = useMemo(
    () => lines.reduce((sum, l) => sum + (parseFloat(l.share) || 0), 0),
    [lines]
  );
  const myShare = Math.round((gross - sharesTotal + Number.EPSILON) * 100) / 100;
  const sharesExceed = sharesTotal > 0 && sharesTotal > gross;
  const signed = (v: number) => (v < 0 ? `−${formatInr(Math.abs(v))}` : formatInr(v));

  /**
   * Divides the group's total equally among the people already listed.
   *
   * The remainder from an indivisible total goes on the FIRST person rather
   * than being dropped, so the shares still add up to the total exactly -
   * losing a paisa here would show up later as a reconciliation warning about
   * a split that was actually fine.
   */
  function splitEqually() {
    const people = lines.filter((l) => l.person.trim());
    if (people.length === 0 || gross <= 0) return;
    const each = Math.floor((gross / people.length) * 100) / 100;
    const remainder = Math.round((gross - each * people.length) * 100) / 100;
    let i = 0;
    setLines(
      lines.map((l) => {
        if (!l.person.trim()) return l;
        const share = i === 0 ? Math.round((each + remainder) * 100) / 100 : each;
        i += 1;
        return { ...l, share: String(share) };
      })
    );
  }

  function toggle(id: number) {
    if (byId.get(id)?.groupName) return; // already in a group
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function reset() {
    setSelected(new Set());
    setConfiguring(false);
    setName("");
    setCategoryId("");
    setLines([]);
    setError(null);
    setPending(false);
  }

  async function create() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/settlements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          categoryId: categoryId ? Number(categoryId) : null,
          transactionIds: [...selected],
          // Blank rows are form scaffolding, not people.
          lines: lines
            .filter((l) => l.person.trim() && parseFloat(l.share) > 0)
            .map((l) => ({ person: l.person.trim(), share: parseFloat(l.share) })),
        }),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") throw new Error(json.error ?? "Failed to create group");
      reset();
      router.refresh();
      router.push("/groups");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create group");
      setPending(false);
    }
  }

  return (
    <GroupSelectionContext.Provider
      value={{ selecting: true, selected, toggle, groupNameFor: (id) => byId.get(id)?.groupName ?? null }}
    >
      {/* Toolbar. Appears only once something is selected, so the list reads
          normally until there is a selection to act on. */}
      {selected.size > 0 && (
        <div className="sticky top-0 z-20 flex items-center justify-between gap-3 rounded-2xl border border-[var(--sk-accent-edge)] bg-[var(--sk-accent-tint)] px-3 py-2.5">
          <span className="min-w-0 text-[0.8125rem] font-semibold text-[var(--sk-ink)]">
            {selected.size} selected
            <span className="font-normal text-[var(--sk-ink-2)]"> · {signed(gross)} net</span>
          </span>
          <span className="flex shrink-0 gap-2">
            <button type="button" onClick={reset}
              className="rounded-full px-3 py-1.5 text-[0.8125rem] font-medium text-[var(--sk-ink-2)]">
              Clear
            </button>
            <button
              type="button"
              onClick={() => setConfiguring(true)}
              className="rounded-full border border-[var(--sk-accent-edge)] bg-[var(--sk-accent)] px-3.5 py-1.5 text-[0.8125rem] font-semibold text-[var(--sk-accent-on)]"
            >
              Group expenses
            </button>
          </span>
        </div>
      )}

      {children}

      {configuring && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Configure group"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:p-6"
          onClick={() => !pending && setConfiguring(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-h-[88vh] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-3xl border border-[var(--sk-hair)] bg-[var(--sk-surface)] p-5 pb-8 sm:rounded-3xl sm:pb-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-[var(--sk-ink)]">Group expenses</h2>
                <p className="mt-0.5 text-[0.8125rem] text-[var(--sk-ink-3)]">
                  {selected.size} transaction{selected.size === 1 ? "" : "s"} · {signed(gross)} net
                </p>
              </div>
              <button type="button" onClick={() => setConfiguring(false)} aria-label="Close"
                className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[var(--sk-hair-strong)] text-[var(--sk-ink-2)]">
                ✕
              </button>
            </div>

            <label className="mt-4 flex flex-col gap-1">
              <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--sk-ink-3)]">
                Name
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Dinner at Toit"
                autoFocus
                className="rounded-xl border border-[var(--sk-hair-strong)] px-3 py-2.5 text-sm"
              />
            </label>

            {/* The parent's own category. Daughters keep theirs as record, but
                this is what the pie and every analytic see for this group. */}
            <label className="mt-4 flex flex-col gap-1">
              <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--sk-ink-3)]">
                Category
              </span>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="rounded-xl border border-[var(--sk-hair-strong)] px-3 py-2.5 text-sm"
              >
                <option value="">Largest transaction&apos;s category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.parentName ? `${c.parentName} › ${c.name}` : c.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="mt-4 flex flex-col gap-2">
              <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--sk-ink-3)]">
                Who owes you
              </span>
              {lines.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={l.person}
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, person: e.target.value } : x)))}
                    placeholder="Name"
                    className="min-w-0 flex-1 rounded-xl border border-[var(--sk-hair-strong)] px-3 py-2 text-sm"
                  />
                  <input
                    value={l.share}
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, share: e.target.value } : x)))}
                    inputMode="decimal"
                    placeholder="0"
                    className="w-24 shrink-0 rounded-xl border border-[var(--sk-hair-strong)] px-3 py-2 text-sm tabular-nums"
                  />
                  <button type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))}
                    aria-label={`Remove ${l.person || "person"}`}
                    className="shrink-0 px-2 text-[var(--sk-ink-3)]">✕</button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setLines([...lines, { person: "", share: "" }])}
                  className="rounded-full border border-[var(--sk-hair-strong)] px-3 py-1.5 text-[0.75rem] font-medium text-[var(--sk-ink-2)]"
                >
                  + Add person
                </button>
                <button
                  type="button"
                  onClick={splitEqually}
                  disabled={lines.filter((l) => l.person.trim()).length === 0 || gross <= 0}
                  className="rounded-full border border-[var(--sk-accent-edge)] px-3 py-1.5 text-[0.75rem] font-medium text-[var(--sk-accent-ink)] disabled:opacity-40"
                >
                  Split equally
                </button>
              </div>
              <p className="text-[0.75rem] text-[var(--sk-ink-3)]">
                Add nobody if this was a pot you only passed money through — it just nets out.
              </p>
            </div>

            {/* What this will actually do to spend, live. */}
            <dl className="mt-4 rounded-xl bg-[var(--sk-plane)] p-3 text-[0.8125rem]">
              <div className="flex justify-between">
                <dt className="text-[var(--sk-ink-3)]">Paid out, less received</dt>
                <dd className="tabular-nums">{signed(gross)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--sk-ink-3)]">Others&apos; shares</dt>
                <dd className="tabular-nums">{sharesTotal > 0 ? `− ${formatInr(sharesTotal)}` : "—"}</dd>
              </div>
              <div className="mt-1 flex justify-between border-t border-[var(--sk-hair)] pt-1.5 font-semibold">
                <dt>Counts as your spend</dt>
                <dd className="tabular-nums">{formatInr(myShare > 0 ? myShare : 0)}</dd>
              </div>
            </dl>

            {/* Over-allocation is an error and reads red. It used to fall into
                the "came out ahead" branch below and render GREEN - a mistake
                congratulating itself. That branch now fires only when the
                shares are NOT the cause. */}
            {sharesExceed && (
              <p className="mt-2 rounded-xl border border-[var(--sk-bad)]/25 bg-[var(--sk-bad-tint)] px-3 py-2 text-[0.75rem] font-semibold text-[var(--sk-bad)]">
                Shares come to {formatInr(sharesTotal)}, more than the {signed(gross)} that left your account.
                You can still save this — check the split.
              </p>
            )}
            {!sharesExceed && myShare <= 0 && selected.size > 0 && (
              <p className="mt-2 rounded-xl bg-[var(--sk-good-tint)] px-3 py-2 text-[0.75rem] text-[var(--sk-good)]">
                You came out ahead by {formatInr(Math.abs(myShare))}. A gain is not an expense, so this will add
                nothing to your spend — the group is still kept in full.
              </p>
            )}
            {error && <p className="mt-2 text-[0.75rem] text-[var(--sk-bad)]">{error}</p>}

            <button
              type="button"
              disabled={pending || !name.trim()}
              onClick={create}
              className="mt-4 w-full rounded-xl border border-[var(--sk-accent-edge)] bg-[var(--sk-accent)] py-3 text-[0.875rem] font-semibold text-[var(--sk-accent-on)] disabled:opacity-40"
            >
              {pending ? "Saving…" : `Create group of ${selected.size}`}
            </button>
          </div>
        </div>
      )}
    </GroupSelectionContext.Provider>
  );
}
