// Group settlements.
//
// One model for two situations that look different but are the same shape. In
// both, some of the money that moved through my accounts was never mine to
// spend, and the group exists to say how much.
//
// Pure functions only - no Supabase - so the arithmetic can be tested directly.

export type GroupStatus = "open" | "closed";
export type LineStatus = "open" | "settled";

export interface SettlementLine {
  id: number;
  person: string;
  share: number;
  status: LineStatus;
}

/** A transaction as the settlement maths needs to see it. */
export interface GroupTransaction {
  id: number;
  type: string;
  status: string | null;
  currency: string;
  amount: number | null;
  /** phone_received_at - what places the group in time. */
  receivedAt: string | null;
  categoryId: number | null;
}

export interface SettlementGroup {
  id: number;
  name: string;
  status: GroupStatus;
  createdAt: string;
  transactions: GroupTransaction[];
  lines: SettlementLine[];
}

/**
 * Transactions inside a group that the arithmetic counts.
 *
 * Only success and INR are required. The usual is_transfer and counts_as_spend
 * filters are deliberately NOT applied here: grouping is an explicit statement
 * that these transactions belong together, which is a stronger signal than a
 * category flag set automatically.
 */
export function countsInGroup(t: GroupTransaction): boolean {
  return t.status === "success" && t.currency === "INR" && typeof t.amount === "number";
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/** What actually left my accounts: debits minus credits. */
export function groupGross(group: SettlementGroup): number {
  let gross = 0;
  for (const t of group.transactions) {
    if (!countsInGroup(t)) continue;
    const amount = t.amount as number;
    if (t.type === "debit") gross += amount;
    else if (t.type === "credit") gross -= amount;
  }
  return round2(gross);
}

/** Everyone else's share of it, settled or not. */
export function groupShares(group: SettlementGroup): number {
  return round2(group.lines.reduce((sum, l) => sum + l.share, 0));
}

/**
 * What the group really cost me, and the only figure that reaches a spend
 * total: gross minus what other people's shares account for.
 *
 * Settled lines are included on purpose. A share was pass-through from the
 * moment I paid it; being repaid changes who is holding the money, not whether
 * I spent it. Deducting only unsettled lines would make my past spending climb
 * every time somebody paid me back.
 */
export function groupNet(group: SettlementGroup): number {
  return round2(groupGross(group) - groupShares(group));
}

/** Still outstanding - what the homepage card counts. */
export function groupOwed(group: SettlementGroup): number {
  return round2(
    group.lines.filter((l) => l.status === "open").reduce((sum, l) => sum + l.share, 0)
  );
}

/**
 * A group is closed once nothing is outstanding. A group with no lines - the
 * pot-manager case - is therefore born closed, which is right: there is nobody
 * to chase.
 */
export function deriveStatus(lines: SettlementLine[]): GroupStatus {
  return lines.some((l) => l.status === "open") ? "open" : "closed";
}

/**
 * When the group lands in time.
 *
 * A group is one economic event, so its whole net is attributed to a single
 * instant rather than smeared over its transactions - otherwise a period
 * boundary could split a settlement and leave each side reading as nonsense.
 * The earliest transaction is the anchor: it is when the shared cost started,
 * and unlike the latest it does not move as more transactions are added.
 */
export function groupAnchor(group: SettlementGroup): string | null {
  let earliest: string | null = null;
  for (const t of group.transactions) {
    if (!countsInGroup(t) || !t.receivedAt) continue;
    if (earliest === null || t.receivedAt < earliest) earliest = t.receivedAt;
  }
  return earliest;
}

/**
 * Which category the net is filed under: the one carrying the largest debit.
 * A dinner group whose big debit was Dining shows its net under Dining, which
 * is what makes the category breakdown still mean something.
 */
export function groupCategory(group: SettlementGroup): number | null {
  let best: { categoryId: number | null; amount: number } | null = null;
  for (const t of group.transactions) {
    if (!countsInGroup(t) || t.type !== "debit") continue;
    const amount = t.amount as number;
    if (!best || amount > best.amount) best = { categoryId: t.categoryId, amount };
  }
  return best?.categoryId ?? null;
}

export interface ReconciliationWarning {
  kind: "shares-exceed-gross";
  gross: number;
  shares: number;
}

/**
 * Whether the lines are self-consistent with what was spent.
 *
 * Only flags shares that exceed the group's gross, which would mean I somehow
 * owe money on a bill I paid. Uneven splits are left alone deliberately: real
 * ones often are, and my share is simply whatever remains. Advisory only - the
 * caller warns and continues.
 */
export function reconcile(group: SettlementGroup): ReconciliationWarning | null {
  const shares = groupShares(group);
  // Nobody owes anything, so there is no split to be wrong about. Without this
  // a pot that came out ahead warns about itself: zero shares are trivially
  // "more than" a negative gross.
  if (shares <= 0) return null;
  const gross = groupGross(group);
  if (shares > gross) return { kind: "shares-exceed-gross", gross, shares };
  return null;
}

/** My own share of the group: whatever the other lines do not account for. */
export function myShare(group: SettlementGroup): number {
  return groupNet(group);
}

/**
 * What the group contributes to spend, which is NOT always its net.
 *
 * A group that came out ahead - a poker night that paid out less than it took
 * in - has a negative net, and a negative is not an expense. It contributes
 * zero: nothing to a total, nothing to a category, nothing to a budget. The
 * group itself is untouched and still shows its true -Rs 350 in the groups
 * tab; it is only excluded from expense arithmetic, never hidden.
 *
 * Letting the negative through instead would have quietly funded other
 * spending - a good night at cards would make a week of restaurants look
 * cheaper - and would have asked a pie chart to draw a slice with no
 * proportion. Both problems disappear here rather than being handled
 * downstream.
 */
export function groupSpendContribution(group: SettlementGroup): number {
  const net = groupNet(group);
  return net > 0 ? net : 0;
}
