import { supabase } from "@/lib/supabase";
import { CopyPromptButton } from "@/components/CopyPromptButton";

export const dynamic = "force-dynamic";

type GapRow = {
  id: number;
  amount: number | null;
  currency: string;
  transaction_date: string | null;
  classifier_gap_comment: string | null;
  raw_messages: { message: string } | null;
};

function buildPrompt(rows: GapRow[]): string {
  const intro = `Here are ${rows.length} transaction${rows.length === 1 ? "" : "s"} with suspected classifier issues. For each, diagnose the underlying pattern gap and fix it generally (not just for this one example), then re-run classification against these rows and check for other historical rows with the same gap.`;

  const items = rows.map((row, i) => {
    const message = row.raw_messages?.message ?? "(raw message unavailable)";
    const comment = row.classifier_gap_comment ?? "(no comment)";
    return `${i + 1}. Message: "${message}"\n   Comment: ${comment}`;
  });

  return [intro, "", ...items].join("\n");
}

export default async function ClassifierGapsPage() {
  const { data, error } = await supabase
    .from("transactions")
    .select("id, amount, currency, transaction_date, classifier_gap_comment, raw_messages(message)")
    .eq("classifier_gap_reported", true)
    .order("transaction_date", { ascending: false, nullsFirst: false })
    .returns<GapRow[]>();

  if (error) {
    return (
      <main className="p-6">
        <p className="text-red-600">Failed to load classifier gaps: {error.message}</p>
      </main>
    );
  }

  const rows = data ?? [];

  return (
    <main className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Classifier gaps</h1>
          <p className="text-sm text-zinc-500">
            {rows.length} reported transaction{rows.length === 1 ? "" : "s"}
          </p>
        </div>
        {rows.length > 0 && <CopyPromptButton prompt={buildPrompt(rows)} />}
      </div>

      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <div key={row.id} className="flex flex-col gap-1 rounded border border-zinc-200 p-4 dark:border-zinc-800">
            <span className="text-sm text-zinc-500">
              {row.transaction_date ?? "—"} · {row.currency} {row.amount ?? "—"}
            </span>
            <p className="whitespace-pre-wrap rounded bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
              {row.raw_messages?.message ?? "(raw message unavailable)"}
            </p>
            <p className="text-sm">
              <span className="font-medium">Comment: </span>
              {row.classifier_gap_comment ?? <span className="text-zinc-400">(no comment)</span>}
            </p>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="rounded border border-zinc-200 p-6 text-center text-zinc-500 dark:border-zinc-800">
            No classifier gaps reported.
          </p>
        )}
      </div>
    </main>
  );
}
