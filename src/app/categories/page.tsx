import { supabase } from "@/lib/supabase";
import { CategoryManager, type ManagedCategory } from "@/components/CategoryManager";
import { startTiming } from "@/lib/timing";

export const dynamic = "force-dynamic";

type CategoryRow = {
  id: number;
  name: string;
  parent_id: number | null;
  counts_as_spend: boolean;
  is_protected: boolean;
};

export default async function CategoriesPage() {
  const endTiming = startTiming("GET /categories");
  try {
    return await renderCategoriesPage();
  } finally {
    endTiming();
  }
}

async function renderCategoriesPage() {
  const [{ data, error }, { data: assigned, error: assignedError }] = await Promise.all([
    supabase
      .from("categories")
      .select("id, name, parent_id, counts_as_spend, is_protected")
      .order("name", { ascending: true })
      .returns<CategoryRow[]>(),
    // Transaction counts per category. Shown next to each row because the
    // consequences of editing a category depend entirely on how much is
    // already filed under it.
    supabase.from("transactions").select("category_id").not("category_id", "is", null),
  ]);

  if (error) {
    return (
      <main className="p-4">
        <h1 className="text-lg font-semibold">Categories</h1>
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">
          Failed to load categories: {error.message}
          {/failed|column/i.test(error.message) && (
            <span className="mt-2 block text-zinc-600 dark:text-zinc-400">
              If this mentions <code>is_protected</code>, the category-protection migration hasn&apos;t
              been applied yet.
            </span>
          )}
        </p>
      </main>
    );
  }

  if (assignedError) {
    console.error("Failed to count transactions per category:", assignedError);
  }

  const counts = new Map<number, number>();
  for (const row of assigned ?? []) {
    const id = (row as { category_id: number | null }).category_id;
    if (id != null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const categories: ManagedCategory[] = (data ?? []).map((c) => ({
    ...c,
    transactionCount: counts.get(c.id) ?? 0,
  }));

  const protectedCount = categories.filter((c) => c.is_protected).length;
  const excludedCount = categories.filter((c) => !c.counts_as_spend).length;

  return (
    <main className="p-4">
      <h1 className="text-lg font-semibold">Categories</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        {categories.length} categories · {excludedCount} excluded from spend · {protectedCount}{" "}
        protected. Additions and renames appear immediately in the picker everywhere else.
      </p>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
        Renaming a protected category is allowed, but four are looked up by literal name in code —{" "}
        <span className="font-medium">Investments</span>,{" "}
        <span className="font-medium">Indulgence</span>,{" "}
        <span className="font-medium">Person-to-Person</span> and{" "}
        <span className="font-medium">Ignore</span>. Renaming any of those breaks that lookup until
        the code is updated to match.
      </p>

      <CategoryManager categories={categories} />
    </main>
  );
}
