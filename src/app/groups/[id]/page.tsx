import Link from "next/link";
import { notFound } from "next/navigation";
import {
  groupAnchor, groupCategory, groupDisplayLabel, groupGross, groupNet, groupOwed,
  groupShares, groupSpendContribution, reconcile,
} from "@/lib/settlement";
import { SettleLineButton } from "@/components/SettleLineButton";
import { GroupEditor } from "@/components/GroupEditor";
import { fetchGroupsPageData } from "@/lib/groupsPageData";
import { formatInr } from "@/lib/formatInr";
import { istDateTime, istDateWithAge } from "@/lib/formatIst";
import { startTiming } from "@/lib/timing";

export const dynamic = "force-dynamic";

export default async function GroupDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const endTiming = startTiming("GET /groups/[id]");
  try {
    const { id } = await params;
    const sp = await searchParams;
    return await renderGroup(Number(id), sp.edit === "1");
  } finally {
    endTiming();
  }
}

async function renderGroup(id: number, startEditing: boolean) {
  if (!Number.isInteger(id)) notFound();
  const { groups, categories, payees, categoryNames, candidates, knownPeople } =
    await fetchGroupsPageData();
  const group = groups.find((g) => g.id === id);
  if (!group) notFound();

  const gross = groupGross(group);
  const net = groupNet(group);
  const spend = groupSpendContribution(group);
  const shares = groupShares(group);
  const owed = groupOwed(group);
  const warning = reconcile(group);
  const hasPeople = group.lines.length > 0;
  const resolvedCategoryId = groupCategory(group);
  const categoryLabel =
    resolvedCategoryId != null ? categoryNames.get(resolvedCategoryId) ?? "—" : "Uncategorised";
  const label = groupDisplayLabel(group, resolvedCategoryId != null ? categoryNames.get(resolvedCategoryId) ?? null : null, (n) => formatInr(n));
  const dated = istDateWithAge(groupAnchor(group));
  const members = group.transactions.map((t) => ({
    id: t.id,
    label: `${t.type === "credit" ? "+" : "−"}${formatInr(t.amount ?? 0)} ${payees.get(t.id) ?? "—"}`,
  }));

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 pb-16 pt-3">
      <Link href="/groups" className="flex min-h-11 items-center text-[0.8125rem] font-medium text-[var(--sk-accent-ink)]">
        ← Grouped expenses
      </Link>

      <header>
        <h1 className="text-xl font-semibold text-[var(--sk-ink)]">{label}</h1>
        <p className="mt-1 text-[0.8125rem] text-[var(--sk-ink-3)]">
          {group.transactions.length} transaction{group.transactions.length === 1 ? "" : "s"}
          {" · "}{categoryLabel}
          {hasPeople && ` · ${group.lines.length} ${group.lines.length === 1 ? "person" : "people"}`}
          {dated && ` · ${dated}`}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3">
        <Stat label={group.status === "open" ? "Owed to you" : "Settled"} value={formatInr(owed)} accent />
        <Stat label="Yours" value={signedInr(net)} />
      </div>

      {/* Settling lives here and only here. It is the tap that says a debt is
          done with, and it needs the person, the amount and the rest of the
          group visible around it - not a button in a list row. */}
      {hasPeople && (
        <section className="overflow-hidden rounded-2xl border border-[var(--sk-hair)] bg-[var(--sk-surface)]">
          {group.lines.map((l) => (
            <div key={l.id} className="flex items-center gap-3 border-b border-[var(--sk-hair)] px-4 py-3 last:border-b-0">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[0.9375rem] text-[var(--sk-ink)]">{l.person}</span>
                {l.status === "open" && istDateWithAge(l.createdAt) && (
                  <span className="text-[0.6875rem] tabular-nums text-[var(--sk-ink-3)]">
                    {istDateWithAge(l.createdAt)}
                  </span>
                )}
              </span>
              <span className={`shrink-0 text-[0.9375rem] font-medium tabular-nums ${
                l.status === "settled" ? "text-[var(--sk-ink-3)] line-through" : "text-[var(--sk-ink)]"
              }`}>
                {formatInr(l.share)}
              </span>
              <SettleLineButton lineId={l.id} settled={l.status === "settled"} />
            </div>
          ))}
        </section>
      )}

      {net <= 0 && (
        <p className="rounded-xl bg-[var(--sk-good-tint)] px-3 py-2 text-[0.75rem] text-[var(--sk-good)]">
          You came out ahead by {formatInr(Math.abs(net))}. A gain is not an expense, so this adds nothing to
          your spend — the record stays here in full.
        </p>
      )}

      {warning && (
        <p className="rounded-xl border border-[var(--sk-bad)]/25 bg-[var(--sk-bad-tint)] px-3 py-2 text-[0.75rem] font-semibold text-[var(--sk-bad)]">
          Shares add up to {formatInr(warning.shares)}, more than the {signedInr(warning.gross)} that left your
          account. Check the split.
        </p>
      )}

      <section className="rounded-2xl border border-[var(--sk-hair)] bg-[var(--sk-surface)] p-4">
        <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--sk-ink-3)]">Breakdown</h2>
        <dl className="mt-2 flex flex-col gap-1 text-[0.8125rem]">
          <Row label="Paid out, less received" value={signedInr(gross)} />
          <Row label="Others' shares" value={shares > 0 ? `− ${formatInr(shares)}` : "—"} />
          <div className="mt-1 flex justify-between border-t border-[var(--sk-hair)] pt-2">
            <dt className="font-semibold text-[var(--sk-ink)]">Counts as your spend</dt>
            <dd className="font-semibold tabular-nums text-[var(--sk-ink)]">{formatInr(spend)}</dd>
          </div>
        </dl>

        <h3 className="mt-4 text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--sk-ink-3)]">
          Transactions ({group.transactions.length})
        </h3>
        <ul className="mt-2 flex flex-col gap-1.5">
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
      </section>

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
        startOpen={startEditing}
        onUngroupedHref="/groups"
      />
    </main>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-[var(--sk-hair)] bg-[var(--sk-surface)] px-4 py-3">
      <span className="block text-[0.6875rem] uppercase tracking-wide text-[var(--sk-ink-3)]">{label}</span>
      <span className={`mt-0.5 block text-[1.25rem] font-semibold tabular-nums ${
        accent ? "text-[var(--sk-accent-ink)]" : "text-[var(--sk-ink)]"
      }`}>
        {value}
      </span>
    </div>
  );
}

// A minus belongs in front of the currency symbol, not between it and the
// digits: formatInr(-350) alone renders "₹-350.00".
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
