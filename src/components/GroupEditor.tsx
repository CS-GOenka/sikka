"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CategoryOption } from "@/lib/gemini";
import { formatInr } from "@/lib/formatInr";

/**
 * Editing a group after the fact: its category, and which transactions are in
 * it.
 *
 * Nothing here recalculates anything by hand. The group's net, whether that net
 * counts as spend, the category the spend is filed under and the reconciliation
 * warning are all derived from the group's current transactions every time they
 * are read - so changing membership changes all of them at once. That is
 * precisely why none of them is stored.
 */
export function GroupEditor({
  groupId,
  name,
  hideName,
  people,
  knownPeople,
  categoryId,
  resolvedCategoryLabel,
  categories,
  members,
  candidates,
}: {
  groupId: number;
  name: string;
  hideName: boolean;
  people: { id: number; person: string; share: number; settled: boolean }[];
  knownPeople: string[];
  categoryId: number | null;
  /**
   * The category the group actually files under right now, already resolved.
   * The picker names that, and only that. How an unset category gets resolved
   * is a backend rule, and putting the rule on screen ("largest transaction's
   * category") asked the reader to evaluate it against their own data to find
   * out what their group is filed as - which is the one thing they came here
   * to read.
   */
  resolvedCategoryLabel: string;
  categories: CategoryOption[];
  members: { id: number; label: string }[];
  candidates: { id: number; label: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [draftName, setDraftName] = useState(name);
  const [newPerson, setNewPerson] = useState("");
  const [newShare, setNewShare] = useState("");
  // Shares are edited as text so a half-typed "12." or an emptied box is not
  // rounded, rejected or sent. Only a blur with a changed, valid number saves.
  const [shareDrafts, setShareDrafts] = useState<Record<number, string>>({});

  async function call(url: string, method: string, body: unknown) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") throw new Error(json.error ?? "Failed");
      setAdding("");
      setShareDrafts({});
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="mt-3 text-[0.75rem] font-medium text-[var(--sk-accent-ink)]">
        Edit group
      </button>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-2xl bg-[var(--sk-plane)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--sk-ink-3)]">
          Edit group
        </span>
        <button type="button" onClick={() => setOpen(false)} className="text-[0.75rem] text-[var(--sk-ink-3)]">
          Done
        </button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[0.75rem] text-[var(--sk-ink-3)]">Name</span>
        <input
          type="text"
          value={draftName}
          disabled={pending}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={() => {
            const next = draftName.trim();
            if (!next) { setDraftName(name); return; }
            if (next !== name) call("/api/settlements", "PATCH", { groupId, name: next });
          }}
          className="rounded-xl border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] px-3 py-2 text-sm"
        />
      </label>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={hideName}
          disabled={pending}
          onChange={(e) => call("/api/settlements", "PATCH", { groupId, hideName: e.target.checked })}
          className="mt-0.5 size-4 shrink-0"
        />
        <span className="text-[0.75rem] text-[var(--sk-ink-3)]">
          Hide the name
          <span className="block text-[0.6875rem]">
            Shows the category and what it cost instead, here and on the homepage. The transactions
            inside keep their own names.
          </span>
        </span>
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-[0.75rem] text-[var(--sk-ink-3)]">People</span>
        {people.length === 0 && (
          <span className="text-[0.75rem] text-[var(--sk-ink-3)]">Nobody yet - this counts entirely as yours.</span>
        )}
        {people.map((p) => (
          <div key={p.id} className="flex items-center gap-2 text-[0.8125rem]">
            <span className="min-w-0 flex-1 truncate text-[var(--sk-ink)]">
              {p.person}
              {p.settled && <span className="ml-1 text-[var(--sk-ink-3)]">· settled</span>}
            </span>
            <span className="shrink-0 text-[var(--sk-ink-3)]">₹</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={shareDrafts[p.id] ?? String(p.share)}
              disabled={pending}
              onChange={(e) => setShareDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
              onBlur={() => {
                const raw = shareDrafts[p.id];
                if (raw === undefined) return;
                const next = Number(raw);
                if (raw.trim() === "" || !Number.isFinite(next) || next < 0) {
                  setShareDrafts((d) => { const c = { ...d }; delete c[p.id]; return c; });
                  return;
                }
                if (next === p.share) return;
                call("/api/settlements/lines", "PATCH", { lineId: p.id, share: next });
              }}
              className="w-24 shrink-0 rounded-lg border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] px-2 py-1 text-right text-[0.8125rem] tabular-nums"
            />
            <button
              type="button"
              disabled={pending}
              onClick={() => call("/api/settlements/lines", "DELETE", { lineId: p.id })}
              className="shrink-0 rounded-full border border-[var(--sk-hair-strong)] px-2.5 py-1 text-[0.6875rem] font-medium text-[var(--sk-ink-2)] disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <input
            type="text"
            list={`people-${groupId}`}
            placeholder="Add a person…"
            value={newPerson}
            disabled={pending}
            onChange={(e) => setNewPerson(e.target.value)}
            className="min-w-0 flex-1 rounded-xl border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] px-3 py-2 text-sm"
          />
          <datalist id={`people-${groupId}`}>
            {knownPeople.map((n) => <option key={n} value={n} />)}
          </datalist>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="Share"
            value={newShare}
            disabled={pending}
            onChange={(e) => setNewShare(e.target.value)}
            className="w-24 shrink-0 rounded-xl border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] px-2 py-2 text-right text-sm tabular-nums"
          />
          <button
            type="button"
            disabled={pending || !newPerson.trim() || newShare.trim() === "" || !Number.isFinite(Number(newShare))}
            onClick={() => {
              call("/api/settlements/lines", "POST", {
                groupId, person: newPerson.trim(), share: Number(newShare),
              });
              setNewPerson(""); setNewShare("");
            }}
            className="shrink-0 rounded-xl border border-[var(--sk-accent-edge)] bg-[var(--sk-accent)] px-3 py-2 text-[0.8125rem] font-semibold text-[var(--sk-accent-on)] disabled:opacity-40"
          >
            Add
          </button>
        </div>
        {people.length > 0 && (
          <span className="text-[0.6875rem] tabular-nums text-[var(--sk-ink-3)]">
            Shares total {formatInr(people.reduce((sum, p) => sum + p.share, 0))}
          </span>
        )}
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[0.75rem] text-[var(--sk-ink-3)]">Category (what the pie shows)</span>
        <select
          value={categoryId ?? ""}
          disabled={pending}
          onChange={(e) =>
            call("/api/settlements", "PATCH", {
              groupId,
              categoryId: e.target.value ? Number(e.target.value) : null,
            })
          }
          className="rounded-xl border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] px-3 py-2 text-sm"
        >
          <option value="">{resolvedCategoryLabel}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.parentName ? `${c.parentName} › ${c.name}` : c.name}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-[0.75rem] text-[var(--sk-ink-3)]">Transactions</span>
        {members.map((m) => (
          <div key={m.id} className="flex items-center gap-2 text-[0.8125rem]">
            <span className="min-w-0 flex-1 truncate text-[var(--sk-ink)]">{m.label}</span>
            <button
              type="button"
              disabled={pending}
              onClick={() => call("/api/settlements/transactions", "DELETE", { transactionId: m.id })}
              className="shrink-0 rounded-full border border-[var(--sk-hair-strong)] px-2.5 py-1 text-[0.6875rem] font-medium text-[var(--sk-ink-2)] disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {candidates.length > 0 && (
        <div className="flex gap-2">
          <select
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            className="min-w-0 flex-1 rounded-xl border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] px-3 py-2 text-sm"
          >
            <option value="">Add a transaction…</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending || !adding}
            onClick={() => call("/api/settlements/transactions", "POST", { groupId, transactionIds: [Number(adding)] })}
            className="shrink-0 rounded-xl border border-[var(--sk-accent-edge)] bg-[var(--sk-accent)] px-3 py-2 text-[0.8125rem] font-semibold text-[var(--sk-accent-on)] disabled:opacity-40"
          >
            Add
          </button>
        </div>
      )}

      <button
        type="button"
        disabled={pending}
        onClick={() => call("/api/settlements", "DELETE", { groupId })}
        className="self-start rounded-full border border-[var(--sk-bad)]/30 px-3 py-1.5 text-[0.75rem] font-medium text-[var(--sk-bad)] disabled:opacity-50"
      >
        Ungroup
      </button>

      {error && <p className="text-[0.75rem] text-[var(--sk-bad)]">{error}</p>}
      <p className="text-[0.6875rem] text-[var(--sk-ink-3)]">
        Removing a transaction returns it to counting on its own. The group&apos;s net, whether it counts as
        spend at all, and the split warning are all recalculated. Ungrouping can be undone.
      </p>
    </div>
  );
}
