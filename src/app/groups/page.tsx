import Link from "next/link";
import {
  groupAnchor, groupCategory, groupDisplayLabel, groupNet, groupOwed,
  type SettlementGroup,
} from "@/lib/settlement";
import { GroupRowMenu } from "@/components/groups/GroupRowMenu";
import { UndoBanner } from "@/components/UndoBanner";
import { fetchLastUndoable } from "@/lib/settlementUndo";
import { fetchGroupsPageData } from "@/lib/groupsPageData";
import { formatInr } from "@/lib/formatInr";
import { formatAge, istAgeInDays } from "@/lib/formatIst";
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
  const [{ groups, categoryNames }, lastUndoable] = await Promise.all([
    fetchGroupsPageData(),
    fetchLastUndoable(),
  ]);

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
          {open.map((g) => <GroupRow key={g.id} group={g} categoryNames={categoryNames} />)}
        </Section>
      )}
      {closed.length > 0 && (
        <Section title="History">
          {closed.map((g) => <GroupRow key={g.id} group={g} categoryNames={categoryNames} />)}
        </Section>
      )}
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col">
      <h2 className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--sk-ink-3)]">{title}</h2>
      <ul className="overflow-hidden rounded-2xl border border-[var(--sk-hair)] bg-[var(--sk-surface)]">{children}</ul>
    </section>
  );
}

/**
 * One group, one row: what it is, what is outstanding, what it cost me, how
 * long it has been sitting there, and a way in.
 *
 * No settle button. Settling is the one irreversible-feeling tap in this
 * screen and it used to sit inside the row, exactly where a thumb lands to open
 * it - so it moved to the group's own screen, where there is room to see who is
 * being settled and for how much before committing.
 */
function GroupRow({
  group,
  categoryNames,
}: {
  group: SettlementGroup;
  categoryNames: Map<number, string>;
}) {
  const resolvedCategoryId = groupCategory(group);
  const categoryName = resolvedCategoryId != null ? categoryNames.get(resolvedCategoryId) ?? null : null;
  const label = groupDisplayLabel(group, categoryName, (n) => formatInr(n));
  const owed = groupOwed(group);
  const net = groupNet(group);
  const age = formatAge(istAgeInDays(groupAnchor(group)));

  return (
    <li className="border-b border-[var(--sk-hair)] last:border-b-0">
      <div className="flex items-center gap-1 pl-4 pr-1">
        <Link
          href={`/groups/${group.id}`}
          className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2.5 active:bg-[var(--sk-plane)]"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.9375rem] font-medium text-[var(--sk-ink)]">{label}</span>
            <span className="block truncate text-[0.75rem] tabular-nums text-[var(--sk-ink-3)]">
              {net <= 0 ? `${net < 0 ? "−" : ""}${formatInr(Math.abs(net))} net to you` : `${formatInr(net)} yours`}
              {age && ` · ${age}`}
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span className={`block text-[0.9375rem] font-semibold tabular-nums ${
              group.status === "open" ? "text-[var(--sk-accent-ink)]" : "text-[var(--sk-ink-3)]"
            }`}>
              {group.status === "open" ? formatInr(owed) : "Settled"}
            </span>
            {group.status === "open" && (
              <span className="block text-[0.6875rem] text-[var(--sk-ink-3)]">owed</span>
            )}
          </span>
          <span aria-hidden className="shrink-0 text-[var(--sk-ink-3)]">›</span>
        </Link>
        <GroupRowMenu groupId={group.id} groupLabel={label} />
      </div>
    </li>
  );
}
