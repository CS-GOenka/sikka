import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { fetchSettlementGroups } from "@/lib/settlementData";
import {
  groupGross, groupNet, groupOwed, groupShares, groupSpendContribution,
  reconcile, type SettlementGroup,
} from "@/lib/settlement";
import { SettleLineButton } from "@/components/SettleLineButton";
import { formatInr } from "@/lib/formatInr";
import { istDateTime } from "@/lib/formatIst";
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
  const groups = await fetchSettlementGroups();
  // Payees for the transaction lines, which the settlement query does not carry.
  const ids = groups.flatMap((g) => g.transactions.map((t) => t.id));
  const payees = new Map<number, string | null>();
  if (ids.length > 0) {
    const { data } = await supabase
      .from("transactions").select("id, payee").in("id", ids)
      .returns<{ id: number; payee: string | null }[]>();
    for (const t of data ?? []) payees.set(t.id, t.payee);
  }

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

      {groups.length === 0 && (
        <Link href="/transactions" className="rounded-2xl border border-[var(--sk-hair)] bg-[var(--sk-surface)] p-6 text-center text-sm text-[var(--sk-accent-ink)]">
          Go to Transactions →
        </Link>
      )}

      {open.length > 0 && (
        <Section title="Open">
          {open.map((g) => <GroupCard key={g.id} group={g} payees={payees} />)}
        </Section>
      )}
      {closed.length > 0 && (
        <Section title="History">
          {closed.map((g) => <GroupCard key={g.id} group={g} payees={payees} />)}
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

function GroupCard({ group, payees }: { group: SettlementGroup; payees: Map<number, string | null> }) {
  const gross = groupGross(group);
  const net = groupNet(group);
  const spend = groupSpendContribution(group);
  const shares = groupShares(group);
  const owed = groupOwed(group);
  const warning = reconcile(group);

  return (
    <div className="rounded-3xl border border-[var(--sk-hair)] bg-[var(--sk-surface)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[1rem] font-semibold text-[var(--sk-ink)]">{group.name}</h3>
          <p className="mt-0.5 text-xs text-[var(--sk-ink-3)]">
            {group.transactions.length} transaction{group.transactions.length === 1 ? "" : "s"}
            {group.lines.length > 0 && ` · ${group.lines.length} ${group.lines.length === 1 ? "person" : "people"}`}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold ${
          group.status === "open"
            ? "bg-[var(--sk-accent-tint)] text-[var(--sk-accent-ink)]"
            : "bg-[var(--sk-good-tint)] text-[var(--sk-good)]"
        }`}>
          {group.status === "open" ? `${formatInr(owed)} owed` : "Settled"}
        </span>
      </div>

      {/* The arithmetic in full, because a number that silently changes a spend
          total should be checkable rather than trusted. */}
      <dl className="mt-4 flex flex-col gap-1 rounded-2xl bg-[var(--sk-plane)] p-3 text-[0.8125rem]">
        <Row label="Paid out, less received" value={signedInr(gross)} />
        <Row label="Others' shares" value={shares > 0 ? `− ${formatInr(shares)}` : "—"} />
        <div className="mt-1 flex justify-between border-t border-[var(--sk-hair)] pt-2">
          <dt className="font-semibold text-[var(--sk-ink)]">Net</dt>
          <dd className={`font-semibold tabular-nums ${net < 0 ? "text-[var(--sk-good)]" : "text-[var(--sk-ink)]"}`}>
            {signedInr(net)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-[var(--sk-ink-3)]">Counts as your spend</dt>
          <dd className="tabular-nums text-[var(--sk-ink-2)]">{formatInr(spend)}</dd>
        </div>
      </dl>

      {net <= 0 && (
        <p className="mt-2 rounded-xl bg-[var(--sk-good-tint)] px-3 py-2 text-[0.75rem] text-[var(--sk-good)]">
          You came out ahead by {formatInr(Math.abs(net))}. A gain is not an expense, so this adds nothing to
          your spend — the record stays here in full.
        </p>
      )}

      {warning && (
        <p className="mt-2 rounded-xl bg-[var(--sk-warn-tint)] px-3 py-2 text-[0.75rem] text-[var(--sk-warn)]">
          Shares add up to {formatInr(warning.shares)}, more than the {formatInr(warning.gross)} that left your
          account. Saved anyway — check the split.
        </p>
      )}

      {group.lines.length > 0 && (
        <ul className="mt-4 flex flex-col">
          {group.lines.map((l) => (
            <li key={l.id} className="flex items-center gap-3 border-b border-[var(--sk-hair)] py-2.5 last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--sk-ink)]">{l.person}</span>
              <span className={`shrink-0 text-sm font-medium tabular-nums ${
                l.status === "settled" ? "text-[var(--sk-ink-3)] line-through" : "text-[var(--sk-ink)]"
              }`}>
                {formatInr(l.share)}
              </span>
              <SettleLineButton lineId={l.id} settled={l.status === "settled"} />
            </li>
          ))}
        </ul>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-[0.75rem] font-medium text-[var(--sk-accent-ink)]">
          Transactions in this group
        </summary>
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
      </details>
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
