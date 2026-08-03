"use client";

import { useEffect, useState } from "react";

// Shows a persistent warning when the reconcile cron hasn't checked in (its
// heartbeat is stale) - so an ingestion outage surfaces the moment you open the
// app, instead of being discovered days later. Checks on load, on resume, and
// every few minutes.
export function IngestionHealthBanner() {
  const [health, setHealth] = useState<{
    stale: boolean;
    ageMinutes: number | null;
    captureStale: boolean;
    captureAgeHours: number | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/health/ping")
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          setHealth({
            stale: !!j.stale,
            ageMinutes: typeof j.ageMinutes === "number" ? j.ageMinutes : null,
            captureStale: !!j.captureStale,
            captureAgeHours: typeof j.captureAgeHours === "number" ? j.captureAgeHours : null,
          });
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

  if (!health || (!health.stale && !health.captureStale)) return null;

  // Capture staleness (nothing ingested) is the more serious signal - it means
  // transactions are actually being missed - so it takes precedence.
  let message: string;
  if (health.captureStale) {
    const h = health.captureAgeHours == null ? "8h+" : `${Math.floor(health.captureAgeHours)}h`;
    message = `⚠️ No transactions captured in ${h} — the SMS pipeline may be down.`;
  } else {
    const age =
      health.ageMinutes == null
        ? "a while"
        : health.ageMinutes >= 120
          ? `${Math.floor(health.ageMinutes / 60)}h`
          : `${health.ageMinutes}m`;
    message = `⚠️ Ingestion may be down — the reconcile last checked in ${age} ago.`;
  }

  return <div className="bg-red-600 px-4 py-2 text-center text-sm font-medium text-white">{message}</div>;
}
