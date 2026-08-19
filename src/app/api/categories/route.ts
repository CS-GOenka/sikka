import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Create and rename categories for /categories. No delete in this version -
// see the is_protected column, which exists to make deletion safe to add
// later rather than to gate it now.

const MAX_NAME_LENGTH = 60;

function bad(error: string, status = 400) {
  return NextResponse.json({ status: "ERROR", error }, { status });
}

async function parseBody(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Collapse internal whitespace too: "Food  Delivery" and "Food Delivery"
  // must not be able to coexist, since they read as the same category.
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  return name;
}

// Category names must be unique case-insensitively, and this is a correctness
// requirement rather than tidiness: /api/categorize/review resolves the
// category a user picked by name with .single(), so a duplicate name would
// make assigning that category fail outright.
async function nameTaken(name: string, excludeId?: number): Promise<boolean> {
  const query = supabase.from("categories").select("id").ilike("name", name);
  const { data, error } = excludeId == null ? await query : await query.neq("id", excludeId);
  if (error) {
    // Fail closed - treat an unreadable uniqueness check as "taken" rather
    // than letting a duplicate through on a transient error.
    console.error("Category name uniqueness check failed:", error);
    return true;
  }
  return (data?.length ?? 0) > 0;
}

export async function POST(request: NextRequest) {
  const body = await parseBody(request);
  if (body === null) return bad("Request body must be valid JSON");

  const name = normalizeName((body as { name?: unknown })?.name);
  if (!name) return bad(`Expected a non-empty 'name' of at most ${MAX_NAME_LENGTH} characters`);

  const rawParent = (body as { parentId?: unknown })?.parentId;
  const parentId =
    rawParent === null || rawParent === undefined
      ? null
      : typeof rawParent === "number" && Number.isInteger(rawParent)
        ? rawParent
        : NaN;
  if (Number.isNaN(parentId)) return bad("'parentId' must be an integer or null");

  const countsAsSpend = (body as { countsAsSpend?: unknown })?.countsAsSpend;
  const isProtected = (body as { isProtected?: unknown })?.isProtected;
  if (typeof countsAsSpend !== "boolean") return bad("Expected a boolean 'countsAsSpend' field");
  if (typeof isProtected !== "boolean") return bad("Expected a boolean 'isProtected' field");

  if (parentId !== null) {
    const { data: parent, error: parentError } = await supabase
      .from("categories")
      .select("id, parent_id")
      .eq("id", parentId)
      .maybeSingle();
    if (parentError) {
      console.error("Failed to load parent category:", parentError);
      return bad("Could not verify the parent category", 500);
    }
    if (!parent) return bad("That parent category no longer exists");
    // The tree is two levels deep by design; the picker groups leaves under
    // one parent label, and a third level would have nowhere to render.
    if (parent.parent_id !== null) {
      return bad("Subcategories can only be added under a top-level category");
    }
  }

  if (await nameTaken(name)) return bad(`A category named "${name}" already exists`);

  const { data, error } = await supabase
    .from("categories")
    .insert({
      name,
      parent_id: parentId,
      counts_as_spend: countsAsSpend,
      is_protected: isProtected,
    })
    .select("id, name, parent_id, counts_as_spend, is_protected")
    .single();

  if (error || !data) {
    console.error("Failed to create category:", error);
    return bad(error?.message ?? "Failed to create category", 500);
  }

  return NextResponse.json({ status: "OK", category: data });
}

export async function PATCH(request: NextRequest) {
  const body = await parseBody(request);
  if (body === null) return bad("Request body must be valid JSON");

  const id = (body as { id?: unknown })?.id;
  if (typeof id !== "number" || !Number.isInteger(id)) {
    return bad("Expected an integer 'id' field");
  }

  const name = normalizeName((body as { name?: unknown })?.name);
  if (!name) return bad(`Expected a non-empty 'name' of at most ${MAX_NAME_LENGTH} characters`);

  const { data: existing, error: existingError } = await supabase
    .from("categories")
    .select("id, name")
    .eq("id", id)
    .maybeSingle();
  if (existingError) {
    console.error("Failed to load category for rename:", existingError);
    return bad("Could not load that category", 500);
  }
  if (!existing) return bad("That category no longer exists");

  if (await nameTaken(name, id)) return bad(`A category named "${name}" already exists`);

  const { data, error } = await supabase
    .from("categories")
    .update({ name })
    .eq("id", id)
    .select("id, name, parent_id, counts_as_spend, is_protected")
    .single();

  if (error || !data) {
    console.error("Failed to rename category:", error);
    return bad(error?.message ?? "Failed to rename category", 500);
  }

  return NextResponse.json({ status: "OK", category: data, previousName: existing.name });
}
