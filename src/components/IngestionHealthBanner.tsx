"use client";

import { useEffect, useState } from "react";

// Shows a persistent warning when the reconcile cron hasn't checked in (its
// heartbeat is stale) - so an ingestion outage surfaces the moment you open the
// app, instead of being discovered days later. Checks on load, on resume, and
// every few minutes.
export function IngestionHealthBanner() {
  const [stale, setStale] = useState(false);
  const [ageMinutes, setAgeMinutes] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/health/ping")
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          setStale(!!j.stale);
          setAgeMinutes(typeof j.ageMinutes === "number" ? j.ageMinutes : null);
        })
        .catch(() => {});
    };
    check();
    document.addEventListener("visibilitychange", check);
    const iv = setInterval(check, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", check);
      clearInterval(iv);
    };
  }, []);

  if (!stale) return null;
  const age =
    ageMinutes == null ? "a while" : ageMinutes >= 120 ? `${Math.floor(ageMinutes / 60)}h` : `${ageMinutes}m`;

  return (
    <div className="bg-red-600 px-4 py-2 text-center text-sm font-medium text-white">
      ⚠️ Ingestion may be down — the reconcile last checked in {age} ago. New transactions could be missing.
    </div>
  );
}
