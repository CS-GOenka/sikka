/**
 * Rupees with Indian digit grouping (1,61,857 - not 161,857).
 *
 * Defaults to whole rupees: the dashboard's job is to be read at a glance, and
 * paise are noise at that size. Callers that must be exact - the budget push,
 * which quotes a specific transaction - pass 2.
 */
export function formatInr(amount: number, maximumFractionDigits = 0): string {
  return `₹${amount.toLocaleString("en-IN", { maximumFractionDigits })}`;
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
