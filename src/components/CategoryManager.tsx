"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type ManagedCategory = {
  id: number;
  name: string;
  parent_id: number | null;
  counts_as_spend: boolean;
  is_protected: boolean;
  transactionCount: number;
};

type Draft = { parentId: number | null; parentName: string | null };

const inputClass =
  "rounded border border-zinc-300 bg-white px-2 py-1 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900";
const buttonClass =
  "rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900";
const ghostButtonClass =
  "rounded border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-600 hover:text-zinc-950 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-50";

function Badge({ tone, children }: { tone: "amber" | "zinc"; children: React.ReactNode }) {
  const tones = {
    amber:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    zinc: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
  );
}

export function CategoryManager({ categories }: { categories: ManagedCategory[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftCounts, setDraftCounts] = useState(true);
  const [draftProtected, setDraftProtected] = useState(false);

  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const parents = categories.filter((c) => c.parent_id === null);
  const childrenOf = (id: number) => categories.filter((c) => c.parent_id === id);

  function resetDraft() {
    setDraft(null);
    setDraftName("");
    setDraftCounts(true);
    setDraftProtected(false);
  }

  async function submit(url: string, method: string, payload: unknown, onDone: () => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") throw new Error(json.error ?? "Request failed");
      onDone();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  function create() {
    if (!draftName.trim()) return;
    const parentId = draft?.parentId ?? null;
    submit(
      "/api/categories",
      "POST",
      { name: draftName, parentId, countsAsSpend: draftCounts, isProtected: draftProtected },
      () => {
        // Adding the first child turns its parent into a grouping label, which
        // silently removes the parent from the picker. Say so rather than
        // letting a previously-assignable category quietly vanish.
        if (parentId !== null) {
          const parent = categories.find((c) => c.id === parentId);
          if (parent && childrenOf(parentId).length === 0) {
            setNotice(
              `"${parent.name}" now has subcategories, so it becomes a grouping label and is no longer selectable in the picker.` +
                (parent.transactionCount > 0
                  ? ` ${parent.transactionCount} existing transaction${parent.transactionCount === 1 ? "" : "s"} stay assigned to it — recategorize them from /cleanup if you want them under a subcategory.`
                  : "")
            );
          }
        }
        resetDraft();
      }
    );
  }

  function rename(id: number) {
    if (!renameValue.trim()) return;
    submit("/api/categories", "PATCH", { id, name: renameValue }, () => setRenamingId(null));
  }

  function renderRow(category: ManagedCategory, isChild: boolean) {
    const isRenaming = renamingId === category.id;
    const hasChildren = childrenOf(category.id).length > 0;
    return (
      <div
        key={category.id}
        className={`flex flex-wrap items-center gap-2 py-2 ${isChild ? "pl-6" : ""}`}
      >
        {isRenaming ? (
          <>
            <input
              autoFocus
              className={`${inputClass} w-56`}
              value={renameValue}
              disabled={busy}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") rename(category.id);
                if (e.key === "Escape") setRenamingId(null);
              }}
            />
            <button className={buttonClass} disabled={busy} onClick={() => rename(category.id)}>
              Save
            </button>
            <button
              className={ghostButtonClass}
              disabled={busy}
              onClick={() => setRenamingId(null)}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <span className={isChild ? "text-sm" : "text-sm font-medium"}>{category.name}</span>
            {!category.counts_as_spend && <Badge tone="zinc">excluded from spend</Badge>}
            {category.is_protected && <Badge tone="amber">protected</Badge>}
            {hasChildren && <Badge tone="zinc">grouping label</Badge>}
            <span className="text-xs text-zinc-400">
              {category.transactionCount} txn{category.transactionCount === 1 ? "" : "s"}
            </span>
            <button
              className={ghostButtonClass}
              disabled={busy}
              onClick={() => {
                setRenamingId(category.id);
                setRenameValue(category.name);
                setError(null);
                setNotice(null);
              }}
            >
              Rename
            </button>
            {!isChild && (
              <button
                className={ghostButtonClass}
                disabled={busy}
                onClick={() => {
                  setDraft({ parentId: category.id, parentName: category.name });
                  setDraftName("");
                  setDraftCounts(true);
                  setDraftProtected(false);
                  setError(null);
                  setNotice(null);
                }}
              >
                + Subcategory
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      {error && (
        <p className="mt-4 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-4 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          {notice}
        </p>
      )}

      <div className="mt-4">
        <button
          className={buttonClass}
          disabled={busy}
          onClick={() => {
            setDraft({ parentId: null, parentName: null });
            setDraftName("");
            setDraftCounts(true);
            setDraftProtected(false);
            setError(null);
            setNotice(null);
          }}
        >
          + Top-level category
        </button>
      </div>

      {draft && (
        <div className="mt-4 rounded border border-zinc-300 p-3 dark:border-zinc-700">
          <div className="text-sm font-medium">
            {draft.parentName ? `New subcategory under ${draft.parentName}` : "New top-level category"}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              autoFocus
              className={`${inputClass} w-64`}
              placeholder="Category name"
              value={draftName}
              disabled={busy}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
                if (e.key === "Escape") resetDraft();
              }}
            />
          </div>

          {/* Two independent flags: any of the four combinations is valid. */}
          <div className="mt-3 flex flex-col gap-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={draftCounts}
                disabled={busy}
                onChange={(e) => setDraftCounts(e.target.checked)}
              />
              <span>
                Counts as spend
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                  Off means transactions here are excluded from budget and spend totals, the way
                  Investments already behaves.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={draftProtected}
                disabled={busy}
                onChange={(e) => setDraftProtected(e.target.checked)}
              />
              <span>
                Protected
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                  Cannot be deleted in a future version. For categories app logic depends on.
                  Renaming stays allowed.
                </span>
              </span>
            </label>
          </div>

          <div className="mt-3 flex gap-2">
            <button className={buttonClass} disabled={busy || !draftName.trim()} onClick={create}>
              Create
            </button>
            <button className={ghostButtonClass} disabled={busy} onClick={resetDraft}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 divide-y divide-zinc-200 dark:divide-zinc-800">
        {parents.map((parent) => (
          <div key={parent.id} className="py-1">
            {renderRow(parent, false)}
            {childrenOf(parent.id).map((child) => renderRow(child, true))}
          </div>
        ))}
      </div>
    </div>
  );
}
