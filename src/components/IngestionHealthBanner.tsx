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
    phoneArmed: boolean;
    phoneStale: boolean;
    phoneAgeMinutes: number | null;
    monitorStale: boolean;
    monitorAgeMinutes: number | null;
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
            // Optional-chained throughout: an older deployment (or a
            // pre-migration database) simply omits these, and the banner must
            // degrade to its previous behaviour rather than crash.
            phoneArmed: j.phoneHeartbeat?.armed !== false,
            phoneStale: !!j.phoneHeartbeat?.stale,
            phoneAgeMinutes:
              typeof j.phoneHeartbeat?.ageMinutes === "number" ? j.phoneHeartbeat.ageMinutes : null,
            monitorStale: !!j.monitor?.stale,
            monitorAgeMinutes:
              typeof j.monitor?.ageMinutes === "number" ? j.monitor.ageMinutes : null,
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

  const anything =
    health &&
    (health.stale ||
      health.captureStale ||
      health.phoneStale ||
      health.monitorStale ||
      !health.phoneArmed);
  if (!anything) return null;

  const mins = (m: number | null, fallback: string) =>
    m == null ? fallback : m >= 120 ? `${Math.floor(m / 60)}h` : `${m}m`;

  // Ordered by how much each finding invalidates the others.
  //
  // The monitor comes first: it is what raises every other alert, so while it
  // is down none of the warnings below can be trusted to reach you - a silent
  // app would look identical to a healthy one. Then capture staleness (money
  // actually being missed), then the phone, then the Mac.
  let message: string;
  let tone = "bg-red-600";
  if (health!.monitorStale) {
    message = `⚠️ Monitoring itself hasn't run in ${mins(
      health!.monitorAgeMinutes,
      "a while"
    )} — outage alerts may not reach you.`;
  } else if (health!.captureStale) {
    const h = health!.captureAgeHours == null ? "8h+" : `${Math.floor(health!.captureAgeHours)}h`;
    message = `⚠️ No transactions captured in ${h} — the SMS pipeline may be down.`;
  } else if (health!.phoneStale) {
    message = `⚠️ No check-in from your phone automations in ${mins(
      health!.phoneAgeMinutes,
      "a while"
    )} — the SMS-capture Shortcut may have stopped.`;
  } else if (health!.stale) {
    message = `⚠️ Ingestion may be down — the reconcile last checked in ${mins(
      health!.ageMinutes,
      "a while"
    )} ago.`;
  } else {
    // Not armed. Amber rather than red: nothing is broken, but the phone
    // monitor cannot fire yet, and saying so is the whole point - an unarmed
    // monitor is otherwise indistinguishable from a healthy one.
    message =
      "⚠️ Phone-heartbeat monitoring is not armed — no check-in received yet, so a missing-ping alert cannot fire.";
    tone = "bg-amber-600";
  }

  return <div className={`${tone} px-4 py-2 text-center text-sm font-medium text-white`}>{message}</div>;
}
