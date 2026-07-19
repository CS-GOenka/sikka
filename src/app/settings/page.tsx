import { supabase } from "@/lib/supabase";
import { SettingsForm } from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { data, error } = await supabase.from("settings").select("daily_budget").eq("id", 1).maybeSingle();

  if (error) {
    return (
      <main className="p-6">
        <h1 className="mb-4 text-xl font-semibold">Settings</h1>
        <p className="text-red-600">Failed to load settings: {error.message}</p>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      <SettingsForm initialDailyBudget={data?.daily_budget ?? null} />
    </main>
  );
}
