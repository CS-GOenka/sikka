"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Installed PWAs are long-lived: when the app is resumed from the background it
// shows the last-painted DOM with no refetch, so /transactions can sit on stale
// data until something (previously, saving in /settings) triggers a
// router.refresh(). This refetches server data whenever the page becomes
// visible again - on tab resume, PWA foreground, and bfcache restore - so the
// list is always current on load. It only fires on visibility/pageshow, not on
// every render, so it doesn't reintroduce per-render latency; the server-side
// category cache is untouched (router.refresh re-runs the page, which still
// reads categories from their 5-minute cache).
export function RefreshOnVisible() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pageshow", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, [router]);
  return null;
}
