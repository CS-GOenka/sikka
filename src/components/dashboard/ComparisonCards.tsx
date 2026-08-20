import { deltaTone, type ComparisonCard } from "@/lib/dashboard";
import { formatInr } from "@/lib/formatInr";

/**
 * Three same-shape cards, so the eye compares totals across them without
 * re-reading the layout each time.
 *
 * The colour rule is fixed and is NOT the stock-market one: spending MORE than
 * the comparison period is red, spending LESS is green, dead level is yellow.
 * Every chip also carries an arrow, so the direction survives a red/green
 * confusion or a greyscale screenshot.
 */
export function ComparisonCards({ cards }: { cards: ComparisonCard[] }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {cards.map((card) => (
        <Card key={card.key} card={card} />
      ))}
    </div>
  );
}

const TONE_CLASS = {
  bad: "text-[var(--sk-bad)]",
  good: "text-[var(--sk-good)]",
  flat: "text-[var(--sk-warn)]",
  none: "text-[var(--sk-ink-3)]",
} as const;

function Card({ card }: { card: ComparisonCard }) {
  const tone = deltaTone(card.deltaPct);

  // No spend at all in the comparison period: a percentage would be division
  // by zero, so the card says so instead of inventing a number. It is still
  // "more than last time", so it is still painted as bad.
  const noBaseline = card.deltaPct === null;
  const toneClass = noBaseline ? TONE_CLASS.bad : TONE_CLASS[tone];

  const arrow = noBaseline ? "↑" : tone === "bad" ? "↑" : tone === "good" ? "↓" : "→";
  const value = noBaseline ? "new" : `${Math.abs(card.deltaPct as number)}%`;

  return (
    <div
      title={`${card.comparisonDetail} · ${formatInr(card.previous)} then, ${formatInr(card.current)} now`}
      className="flex flex-col rounded-2xl border border-[var(--sk-hair)] bg-[var(--sk-surface)] px-3 py-3.5"
    >
      <span className="truncate text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--sk-ink-3)]">
        {card.label}
      </span>
      <span className="mt-1.5 text-[1.0625rem] font-semibold leading-tight tracking-tight tabular-nums text-[var(--sk-ink)]">
        {formatInr(card.current)}
      </span>
      <span className={`mt-1.5 flex items-baseline gap-0.5 text-[0.8125rem] font-semibold tabular-nums ${toneClass}`}>
        <span aria-hidden>{arrow}</span>
        {value}
        <span className="sr-only">
          {noBaseline
            ? " - nothing spent in the comparison period"
            : tone === "bad"
              ? " more than "
              : tone === "good"
                ? " less than "
                : " level with "}
          {card.comparisonLabel.replace("vs ", "")}
        </span>
      </span>
      <span className="mt-0.5 truncate text-[0.625rem] text-[var(--sk-ink-3)]">
        {card.comparisonLabel}
      </span>
    </div>
  );
}
