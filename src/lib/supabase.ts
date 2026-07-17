import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable");
}

// Server-only client using the secret/service role key, which bypasses RLS.
// Never import this module from client components or expose this key with a
// NEXT_PUBLIC_ prefix.
export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
