import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { fetchSettlementGroups } from "@/lib/settlementData";
import {
  groupAnchor, groupCategory, groupDisplayLabel, groupGross, groupNet, groupOwed,
  groupShares, groupSpendContribution, reconcile, type SettlementGroup,
} from "@/lib/settlement";
import type { CategoryOption } from "@/lib/gemini";
import { SettleLineButton } from "@/components/SettleLineButton";
import { GroupEditor } from "@/components/GroupEditor";
import { UndoBanner } from "@/components/UndoBanner";
import { fetchLastUndoable } from "@/lib/settlementUndo";
import { fetchFrequentPeople } from "@/lib/settlementPeople";
import { getAssignableCategories } from "@/lib/gemini";
import { formatInr } from "@/lib/formatInr";
import { istDateTime, istDateWithAge } from "@/lib/formatIst";
import { startTiming } from "@/lib/timing";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  const endTiming = startTiming("GET /groups");
  try {
    return await renderGroups();
  } finally {
    endTiming();
  }
}

async function renderGroups() {
  const [groups, categories, lastUndoable, frequentPeople] = await Promise.all([
    fetchSettlementGroups(),
    getAssignableCategories(),
    fetchLastUndoable(),
    fetchFrequentPeople(50),
  ]);
  const knownPeople = frequentPeople.map((p) => p.name);
  // Payees for the transaction lines, which the settlement query does not carry.
  const ids = groups.flatMap((g) => g.transactions.map((t) => t.id));
  const payees = new Map<number, string | null>();
  const categoryNames = new Map<number, string>();
  if (ids.length > 0) {
    const { data } = await supabase
      .from("transactions").select("id, payee").in("id", ids)
      .returns<{ id: number; payee: string | null }[]>();
    for (const t of data ?? []) payees.set(t.id, t.payee);
  }
  {
    const { data } = await supabase.from("categories").select("id, name")
      .returns<{ id: number; name: string }[]>();
    for (const c of data ?? []) categoryNames.set(c.id, c.name);
  }

  // Ungrouped transactions the editor can offer to add. Recent ones only - a
  // dropdown of three thousand is not a chooser.
  // "No LIVE group" rather than "no group": a transaction released by an
  // ungroup keeps its group id, since nothing is destroyed, so filtering on
  // that column alone would go on treating it as spoken for.
  const liveIds = new Set(groups.map((g) => g.id));
  const { data: freeRows } = await supabase
    .from("transactions")
    .select("id, payee, amount, type, transaction_date, settlement_group_id")
    .eq("status", "success").eq("currency", "INR")
    .order("id", { ascending: false }).limit(120)
    .returns<{ id: number; payee: string | null; amount: number | null; type: string; transaction_date: string | null; settlement_group_id: number | null }[]>();
  const candidates = (freeRows ?? [])
    .filter((t) => t.settlement_group_id === null || !liveIds.has(t.settlement_group_id))
    .slice(0, 60)
    .map((t) => ({
      id: t.id,
      label: `${t.transaction_date ?? ""} ${t.type === "credit" ? "+" : "−"}${formatInr(t.amount ?? 0)} ${t.payee ?? ""}`.trim(),
    }));

  // Open first - those are the ones with something left to do - then history,
  // newest first within each.
  const open = groups.filter((g) => g.status === "open").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const closed = groups.filter((g) => g.status !== "open").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const totalOwed = open.reduce((sum, g) => sum + groupOwed(g), 0);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-4 pb-16 pt-3">
      <div>
        <h1 className="text-xl font-semibold text-[var(--sk-ink)]">Grouped expenses</h1>
        <p className="mt-1 text-sm text-[var(--sk-ink-3)]">
          {groups.length === 0
            ? "No groups yet - select transactions on the Transactions screen to make one."
            : totalOwed > 0
              ? `${formatInr(totalOwed)} owed to you across ${open.length} open ${open.length === 1 ? "settlement" : "settlements"}.`
              : "Nothing outstanding."}
        </p>
      </div>

      <UndoBanner entry={lastUndoable} />

      {groups.length === 0 && (
        <Link href="/transactions" className="rounded-2xl border border-[var(--sk-hair)] bg-[var(--sk-surface)] p-6 text-center text-sm text-[var(--sk-accent-ink)]">
          Go to Transactions →
        </Link>
      )}

      {open.length > 0 && (
        <Section title="Open">
          {open.map((g) => <GroupCard key={g.id} group={g} payees={payees} categoryNames={categoryNames} categories={categories} candidates={candidates} knownPeople={knownPeople} />)}
        </Section>
      )}
      {closed.length > 0 && (
        <Section title="History">
          {closed.map((g) => <GroupCard key={g.id} group={g} payees={payees} categoryNames={categoryNames} categories={categories} candidates={candidates} knownPeople={knownPeople} />)}
        </Section>
      )}
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--sk-ink-3)]">{title}</h2>
      {children}
    </section>
  );
}

function GroupCard({
  group, payees, categoryNames, categories, candidates, knownPeople,
}: {
  group: SettlementGroup;
  payees: Map<number, string | null>;
  categoryNames: Map<number, string>;
  categories: CategoryOption[];
  candidates: { id: number; label: string }[];
  knownPeople: string[];
}) {
  const gross = groupGross(group);
  const net = groupNet(group);
  const spend = groupSpendContribution(group);
  const shares = groupShares(group);
  const owed = groupOwed(group);
  const warning = reconcile(group);
  const hasPeople = group.lines.length > 0;
  // The resolved category - the one the pie actually uses - whether it was
  // picked by hand or derived. How it was arrived at is the backend's business;
  // the screen shows the answer, not the reasoning.
  const resolvedCategoryId = groupCategory(group);
  const categoryLabel =
    resolvedCategoryId != null ? categoryNames.get(resolvedCategoryId) ?? "—" : "Uncategorised";
  // Earliest transaction, per groupAnchor: it is when the shared cost started,
  // and unlike the latest it does not move as more transactions are added.
  const dated = istDateWithAge(groupAnchor(group));
  const members = group.transactions.map((t) => ({
    id: t.id,
    label: `${t.type === "credit" ? "+" : "−"}${formatInr(t.amount ?? 0)} ${payees.get(t.id) ?? "—"}`,
  }));

  return (
    <div className="rounded-3xl border border-[var(--sk-hair)] bg-[var(--sk-surface)] p-5">
      {/* Two layouts, because the two kinds of group are asking different
          questions. A pot with nobody to chase only has to say what it netted;
          a shared bill has to say who still owes what. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[1.0625rem] font-semibold text-[var(--sk-ink)]">
            {groupDisplayLabel(group, resolvedCategoryId != null ? categoryNames.get(resolvedCategoryId) ?? null : null, (n) => formatInr(n))}
          </h3>
          <p className="mt-0.5 text-xs text-[var(--sk-ink-3)]">
            {group.transactions.length} transaction{group.transactions.length === 1 ? "" : "s"}
            {" · "}{categoryLabel}
            {hasPeople && ` · ${group.lines.length} ${group.lines.length === 1 ? "person" : "people"}`}
            {dated && ` · ${dated}`}
          </p>
        </div>
        {/* Owed stays the headline - it is the number with something still to
            do about it. The net sits under it in small type because it answers
            a different question: not what is outstanding, but what the evening
            actually cost me once everyone else's share is taken out. */}
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span className={`rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold ${
            group.status === "open"
              ? "bg-[var(--sk-accent-tint)] text-[var(--sk-accent-ink)]"
              : "bg-[var(--sk-good-tint)] text-[var(--sk-good)]"
          }`}>
            {group.status === "open" ? `${formatInr(owed)} owed` : "Settled"}
          </span>
          <span className="text-[0.6875rem] tabular-nums text-[var(--sk-ink-3)]">
            {net <= 0 ? `${signedInr(net)} net to you` : `${formatInr(net)} yours`}
          </span>
        </div>
      </div>

      {hasPeople ? (
        // An open shared bill is about who still owes what. The arithmetic is
        // still there, moved into the disclosure below - it is reference, not
        // the thing being looked at.
        <ul className="mt-4 flex flex-col">
          {group.lines.map((l) => (
            <li key={l.id} className="flex items-center gap-3 border-b border-[var(--sk-hair)] py-2.5 last:border-b-0">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-[var(--sk-ink)]">{l.person}</span>
                {/* Only while it is open. Once settled the age has stopped
                    meaning anything - nobody is waiting on it. */}
                {l.status === "open" && istDateWithAge(l.createdAt) && (
                  <span className="text-[0.6875rem] tabular-nums text-[var(--sk-ink-3)]">
                    {istDateWithAge(l.createdAt)}
                  </span>
                )}
              </span>
              <span className={`shrink-0 text-sm font-medium tabular-nums ${
                l.status === "settled" ? "text-[var(--sk-ink-3)] line-through" : "text-[var(--sk-ink)]"
              }`}>
                {formatInr(l.share)}
              </span>
              <SettleLineButton lineId={l.id} settled={l.status === "settled"} />
            </li>
          ))}
        </ul>
      ) : (
        // No lines: one condensed line of arithmetic is the whole story.
        <div className="mt-3 flex items-baseline justify-between gap-3 rounded-2xl bg-[var(--sk-plane)] px-3 py-2.5">
          <span className="text-[0.8125rem] text-[var(--sk-ink-3)]">
            Net{spend === 0 && net <= 0 ? " · counts as ₹0" : ""}
          </span>
          <span className={`text-[1.0625rem] font-semibold tabular-nums ${
            net < 0 ? "text-[var(--sk-good)]" : "text-[var(--sk-ink)]"
          }`}>
            {signedInr(net)}
          </span>
        </div>
      )}

      {net <= 0 && (
        <p className="mt-2 rounded-xl bg-[var(--sk-good-tint)] px-3 py-2 text-[0.75rem] text-[var(--sk-good)]">
          You came out ahead by {formatInr(Math.abs(net))}. A gain is not an expense, so this adds nothing to
          your spend — the record stays here in full.
        </p>
      )}

      {warning && (
        <p className="mt-2 rounded-xl border border-[var(--sk-bad)]/25 bg-[var(--sk-bad-tint)] px-3 py-2 text-[0.75rem] font-semibold text-[var(--sk-bad)]">
          Shares add up to {formatInr(warning.shares)}, more than the {signedInr(warning.gross)} that left your
          account. Check the split.
        </p>
      )}

      <details className="group mt-3 rounded-2xl border border-[var(--sk-hair)]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-[0.8125rem] font-semibold text-[var(--sk-accent-ink)]">
          <span>
            {hasPeople ? "Breakdown and transactions" : "Transactions in this group"}
            <span className="ml-1.5 font-normal text-[var(--sk-ink-3)]">
              ({group.transactions.length})
            </span>
          </span>
          <span aria-hidden className="text-base leading-none transition-transform group-open:rotate-180">
            ▾
          </span>
        </summary>

        <div className="border-t border-[var(--sk-hair)] px-3 py-3">
          {hasPeople && (
            <dl className="mb-3 flex flex-col gap-1 rounded-xl bg-[var(--sk-plane)] p-3 text-[0.8125rem]">
              <Row label="Paid out, less received" value={signedInr(gross)} />
              <Row label="Others' shares" value={shares > 0 ? `− ${formatInr(shares)}` : "—"} />
              <div className="mt-1 flex justify-between border-t border-[var(--sk-hair)] pt-2">
                <dt className="font-semibold text-[var(--sk-ink)]">Counts as your spend</dt>
                <dd className="font-semibold tabular-nums text-[var(--sk-ink)]">{formatInr(spend)}</dd>
              </div>
            </dl>
          )}
          <ul className="flex flex-col gap-1.5">
            {group.transactions.map((t) => (
              <li key={t.id} className="flex items-baseline justify-between gap-3 text-[0.8125rem]">
                <span className="min-w-0 truncate text-[var(--sk-ink-2)]">
                  {payees.get(t.id) ?? "—"}
                  <span className="text-[var(--sk-ink-3)]">
                    {t.receivedAt ? ` · ${istDateTime(Date.parse(t.receivedAt))}` : ""}
                  </span>
                </span>
                <span className={`shrink-0 tabular-nums ${t.type === "credit" ? "text-[var(--sk-good)]" : "text-[var(--sk-ink)]"}`}>
                  {t.type === "credit" ? "+" : "−"}{formatInr(t.amount ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </details>

      <GroupEditor
        groupId={group.id}
        name={group.name}
        hideName={group.hideName}
        people={group.lines.map((l) => ({
          id: l.id, person: l.person, share: l.share, settled: l.status === "settled",
        }))}
        knownPeople={knownPeople}
        categoryId={group.categoryId}
        resolvedCategoryLabel={categoryLabel}
        categories={categories}
        members={members}
        candidates={candidates}
      />
    </div>
  );
}

// A minus belongs in front of the currency symbol, not between it and the
// digits: formatInr(-350) alone renders "₹-350".
function signedInr(value: number): string {
  return value < 0 ? `−${formatInr(Math.abs(value))}` : formatInr(value);
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-[var(--sk-ink-3)]">{label}</dt>
      <dd className="tabular-nums text-[var(--sk-ink-2)]">{value}</dd>
    </div>
  );
}
