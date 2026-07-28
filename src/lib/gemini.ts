import { GoogleGenAI } from "@google/genai";
import { unstable_cache } from "next/cache";
import { supabase } from "@/lib/supabase";

const geminiApiKey = process.env.GEMINI_API_KEY;

if (!geminiApiKey) {
  throw new Error("Missing GEMINI_API_KEY environment variable");
}

// Server-only client. Never import this module from client components or
// expose this key with a NEXT_PUBLIC_ prefix.
export const gemini = new GoogleGenAI({ apiKey: geminiApiKey });

export type CategoryOption = {
  id: number;
  name: string;
  parentName: string | null;
};

// Categories that are actions, not spending buckets. They're offered in the
// manual picker (see CategoryPicker's "Actions" group) but must never be
// options the model can choose - otherwise an ambiguous payee the model
// can't place (e.g. a truncated merchant name, or a person's name) gets
// answered "Ignore" and silently dropped from spend, and worse, cached. Real
// person-to-person and merchant transactions can't be auto-ignored as a
// result.
const ACTION_CATEGORY_NAMES = new Set(["Ignore"]);

// Only "leaf" categories (no children) are offered to the model - parent
// categories that have children (e.g. "Food & Dining") are just grouping
// labels, and the more specific child should be picked instead.
async function fetchAssignableCategories(): Promise<CategoryOption[]> {
  const { data: all, error } = await supabase.from("categories").select("id, name, parent_id");
  if (error) {
    throw new Error(`Failed to fetch categories: ${error.message}`);
  }
  const parentIds = new Set(all.filter((c) => c.parent_id !== null).map((c) => c.parent_id));
  const byId = new Map(all.map((c) => [c.id, c]));
  return all
    .filter((c) => !parentIds.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      parentName: c.parent_id ? byId.get(c.parent_id)?.name ?? null : null,
    }));
}

// Categories change rarely (manual edits only), so this is cached across
// requests for 5 minutes instead of hitting Supabase on every /transactions
// and /review page load. A manual category rename/addition can take up to
// 5 minutes to show up in the picker as a result.
export const getAssignableCategories = unstable_cache(fetchAssignableCategories, ["assignable-categories"], {
  revalidate: 300,
});

// Returns category name=null when Gemma's response doesn't cleanly match one
// of the current category names, so callers can flag it for review instead
// of silently mislabeling it. Category names are read live from the
// categories table on every call, so renaming/adding a category needs no
// code change here.
export async function categorizeMerchant(payee: string): Promise<CategoryOption | null> {
  // Action categories (e.g. "Ignore") are filtered out here, not in
  // getAssignableCategories, so the manual picker still offers them while the
  // model never sees them. An "Ignore" response therefore matches nothing
  // below and falls through to null -> needs_review, never an auto-drop.
  const options = (await getAssignableCategories()).filter((o) => !ACTION_CATEGORY_NAMES.has(o.name));
  const listing = options
    .map((o) => (o.parentName ? `${o.name} (${o.parentName})` : o.name))
    .join(", ");

  const response = await gemini.models.generateContent({
    model: "gemma-4-26b-a4b-it",
    contents: `Classify the merchant/payee name below into exactly one of these categories:
${listing}

Merchant: ${payee}

Respond with only the category name (without the parenthetical group), nothing else.`,
  });

  const name = response.text?.trim();
  const match = options.find((o) => o.name === name);
  return match ?? null;
}
