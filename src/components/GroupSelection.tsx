"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { formatInr } from "@/lib/formatInr";

export interface SelectableTransaction {
  id: number;
  type: string;
  amount: number | null;
  payee: string | null;
  dateShort: string;
  groupName: string | null;
}

interface LineDraft {
  person: string;
  share: string;
}

/**
 * Selecting transactions and turning them into a settlement group.
 *
 * Lives above the table rather than inside it: the rows are rendered on the
 * server, so the checkbox state and the whole create flow sit in one client
 * component that the table reports clicks into.
 */
export function GroupSelection({ transactions }: { transactions: SelectableTransaction[] }) {
  const router = useRouter();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byId = useMemo(() => new Map(transactions.map((t) => [t.id, t])), [transactions]);

  // Gross is what the group's spend will be measured from: debits out, credits
  // back in. Shown live so the split can be checked while it is typed.
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
  const sharesExceed = sharesTotal > gross;

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function reset() {
    setSelecting(false);
    setSelected(new Set());
    setNaming(false);
    setName("");
    setLines([]);
    setError(null);
  }

  async function create() {
    setPending(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        transactionIds: [...selected],
        // Blank rows are scaffolding from the form, not people.
        lines: lines
          .filter((l) => l.person.trim() && parseFloat(l.share) > 0)
          .map((l) => ({ person: l.person.trim(), share: parseFloat(l.share) })),
      };
      const res = await fetch("/api/settlements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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

  if (!selecting) {
    return (
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setSelecting(true)}
          className="rounded-full border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] px-3.5 py-1.5 text-[0.8125rem] font-medium text-[var(--sk-ink-2)] active:bg-[var(--sk-plane)]"
        >
          Select to group
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[var(--sk-accent-edge)] bg-[var(--sk-accent-tint)] p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[0.8125rem] font-semibold text-[var(--sk-ink)]">
          {selected.size} selected
          {selected.size > 0 && (
            <span className="font-normal text-[var(--sk-ink-2)]"> · {formatInr(gross)} net</span>
          )}
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={reset}
            className="rounded-full px-3 py-1.5 text-[0.8125rem] font-medium text-[var(--sk-ink-2)]">
            Cancel
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => setNaming(true)}
            className="rounded-full border border-[var(--sk-accent-edge)] bg-[var(--sk-accent)] px-3.5 py-1.5 text-[0.8125rem] font-semibold text-[var(--sk-accent-on)] disabled:opacity-40"
          >
            Create group
          </button>
        </div>
      </div>

      {/* The picker itself: compact rows so a handful can be chosen without
          leaving the screen. */}
      <ul className="max-h-64 overflow-y-auto overscroll-contain rounded-xl bg-[var(--sk-surface)]">
        {transactions.map((t) => {
          const disabled = t.groupName !== null;
          return (
            <li key={t.id} className="border-b border-[var(--sk-hair)] last:border-b-0">
              <label className={`flex items-center gap-2.5 px-3 py-2 text-[0.8125rem] ${disabled ? "opacity-45" : ""}`}>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={selected.has(t.id)}
                  onChange={() => toggle(t.id)}
                  className="size-4 shrink-0 accent-[var(--sk-accent-ink)]"
                />
                <span className="w-14 shrink-0 tabular-nums text-[var(--sk-ink-3)]">{t.dateShort}</span>
                <span className="min-w-0 flex-1 truncate text-[var(--sk-ink)]">
                  {t.payee ?? "—"}
                  {disabled && <span className="text-[var(--sk-ink-3)]"> · in {t.groupName}</span>}
                </span>
                <span className={`shrink-0 tabular-nums ${t.type === "credit" ? "text-[var(--sk-good)]" : "text-[var(--sk-ink)]"}`}>
                  {t.type === "credit" ? "+" : "−"}{formatInr(t.amount ?? 0)}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {naming && (
        <div className="flex flex-col gap-3 rounded-xl bg-[var(--sk-surface)] p-3">
          <label className="flex flex-col gap-1">
            <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--sk-ink-3)]">Group name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Dinner at Toit"
              className="rounded-xl border border-[var(--sk-hair-strong)] px-3 py-2 text-sm"
            />
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--sk-ink-3)]">
              Who owes you (optional)
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
                  aria-label={`Remove ${l.person || "line"}`}
                  className="shrink-0 px-2 text-[var(--sk-ink-3)]">✕</button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setLines([...lines, { person: "", share: "" }])}
              className="self-start rounded-full border border-[var(--sk-hair-strong)] px-3 py-1.5 text-[0.75rem] font-medium text-[var(--sk-ink-2)]"
            >
              + Add person
            </button>
            <p className="text-[0.75rem] text-[var(--sk-ink-3)]">
              Leave empty if nobody owes you — a pot you only passed money through just nets out.
            </p>
          </div>

          {/* Live arithmetic: what this will actually do to spend. */}
          <div className="rounded-xl bg-[var(--sk-plane)] p-3 text-[0.8125rem]">
            <div className="flex justify-between"><span className="text-[var(--sk-ink-3)]">Net of selected</span>
              <span className="tabular-nums">{gross < 0 ? `−${formatInr(Math.abs(gross))}` : formatInr(gross)}</span></div>
            <div className="flex justify-between"><span className="text-[var(--sk-ink-3)]">Others&apos; shares</span>
              <span className="tabular-nums">{sharesTotal > 0 ? `− ${formatInr(sharesTotal)}` : "—"}</span></div>
            <div className="mt-1 flex justify-between border-t border-[var(--sk-hair)] pt-1.5 font-semibold">
              <span>Your spend</span>
              <span className={`tabular-nums ${myShare < 0 ? "text-[var(--sk-good)]" : ""}`}>
                {myShare < 0 ? `−${formatInr(Math.abs(myShare))}` : formatInr(myShare)}
              </span>
            </div>
          </div>

          {sharesExceed && (
            <p className="rounded-xl bg-[var(--sk-warn-tint)] px-3 py-2 text-[0.75rem] text-[var(--sk-warn)]">
              Shares come to more than the {formatInr(gross)} that left your account. You can still save this.
            </p>
          )}
          {error && <p className="text-[0.75rem] text-[var(--sk-bad)]">{error}</p>}

          <button
            type="button"
            disabled={pending || !name.trim() || selected.size === 0}
            onClick={create}
            className="rounded-xl border border-[var(--sk-accent-edge)] bg-[var(--sk-accent)] py-2.5 text-[0.875rem] font-semibold text-[var(--sk-accent-on)] disabled:opacity-40"
          >
            {pending ? "Saving…" : `Create group of ${selected.size}`}
          </button>
        </div>
      )}
    </div>
  );
}
