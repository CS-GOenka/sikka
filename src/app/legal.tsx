/**
 * Shared shell for the two public legal pages.
 *
 * Static and unauthenticated, unlike every other screen here: Google's OAuth
 * verification needs a privacy policy reachable without signing in, and
 * anything that reads Supabase would fail for the anonymous visitor these
 * pages exist for.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-16 pt-3">
      <h1 className="text-xl font-semibold text-[var(--sk-ink)]">{title}</h1>
      <p className="mt-1 text-[0.8125rem] text-[var(--sk-ink-3)]">Last updated {updated}</p>
      <div className="mt-6 flex flex-col gap-6 text-[0.9375rem] leading-relaxed text-[var(--sk-ink-2)]">
        {children}
      </div>
    </main>
  );
}

export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[0.9375rem] font-semibold text-[var(--sk-ink)]">{heading}</h2>
      {children}
    </section>
  );
}
