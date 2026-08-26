"use client";

import { useEffect } from "react";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * Keeps the stored push subscription pointing at this device.
 *
 * Reinstalling the app - which is what you do to pick up a new home-screen
 * icon - throws away the service worker registration and with it the push
 * subscription. Nothing noticed: subscribing only ever happened on the
 * Settings screen behind a button, so the server kept its old endpoint and
 * kept sending to it. Apple answers 201 for a subscription whose app is gone
 * rather than 410, so the sender saw success, pruned nothing, and every
 * notification vanished silently for weeks.
 *
 * This re-registers on load so that recovery needs no one to notice. It only
 * acts where it safely can: installed to the home screen, with permission
 * already granted. Permission that has lapsed still needs the deliberate tap
 * on Settings, because asking for it requires a user gesture.
 */
export function PushSubscriptionSync() {
  useEffect(() => {
    const supported =
      "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    if (!supported || !VAPID_PUBLIC_KEY) return;
    if (Notification.permission !== "granted") return;

    // iOS only allows Web Push from the installed app, so in a plain Safari
    // tab subscribe() throws and there is nothing worth registering anyway.
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (!standalone) return;

    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub =
          (await reg.pushManager.getSubscription()) ??
          (await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
          }));
        if (cancelled || !sub) return;
        // Upserts on endpoint, so a device that is already registered costs one
        // no-op write and a reinstalled one silently repairs itself.
        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        });
      } catch (err) {
        // Never surface this: it is a background repair, and the Settings
        // screen remains the place that reports subscription state properly.
        console.error("Push subscription sync failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
