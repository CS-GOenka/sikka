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
