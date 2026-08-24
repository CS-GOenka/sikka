// The Supabase-backed implementation of the lookups duplicateCheck needs.
// Kept apart from the decision logic so that logic stays importable - and
// testable - without a database connection.
import { supabase } from "@/lib/supabase";
import type { CandidateTransaction, DuplicateLookups, FingerprintInput } from "@/lib/duplicateCheck";

interface ReferenceRow {
  id: number;
  transactions: { id: number; type: string; amount: number | null } | null;
}

export const supabaseDuplicateLookups: DuplicateLookups = {
  async byReference(reference: string): Promise<CandidateTransaction[]> {
    const { data, error } = await supabase
      .from("raw_messages")
      .select("id, transactions(id, type, amount)")
      .ilike("message", `%${reference}%`)
      .limit(20)
      .returns<ReferenceRow[]>();
    if (error) throw new Error(error.message);
    const out: CandidateTransaction[] = [];
    for (const row of data ?? []) if (row.transactions) out.push(row.transactions);
    return out;
  },

  async byFingerprint(input: FingerprintInput): Promise<number | null> {
    let query = supabase
      .from("transactions")
      .select("id")
      .eq("type", input.type)
      .eq("amount", input.amount)
      .eq("transaction_date", input.transactionDate);
    // Null-safe: a null card must match a null card, not "any card".
    query = input.cardOrAccount
      ? query.eq("card_or_account", input.cardOrAccount)
      : query.is("card_or_account", null);
    query = input.payee ? query.eq("payee", input.payee) : query.is("payee", null);

    const { data, error } = await query.limit(1).returns<{ id: number }[]>();
    if (error) throw new Error(error.message);
    return data?.[0]?.id ?? null;
  },
};
