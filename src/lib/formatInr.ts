/**
 * Rupees with Indian digit grouping (1,61,857 - not 161,857), always to the
 * paisa: ₹106.90, never ₹106.9 and never ₹107.
 *
 * Both fraction digits are pinned, not just the maximum. With only a maximum,
 * toLocaleString drops a trailing zero and an amount that is exact to the
 * paisa renders a digit shorter than its neighbours, which breaks the column
 * in any tabular-nums list and reads as a different precision rather than the
 * same number.
 */
export function formatInr(amount: number, fractionDigits = 2): string {
  return `₹${amount.toLocaleString("en-IN", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

/**
 * Rupees shortened for a chart axis or a bar label, where the exact figure is
 * available on tap and the width is not: "₹29.7k", "₹1.7L". Indian scale, so
 * it steps at lakh rather than at million.
 */
export function formatInrCompact(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 1e5) return `₹${trim(amount / 1e5)}L`;
  if (abs >= 1e3) return `₹${trim(amount / 1e3)}k`;
  return `₹${Math.round(amount)}`;
}

// One decimal, but never a trailing ".0" - "₹4k" reads better than "₹4.0k".
function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
