"use client";

import { useEffect, useState } from "react";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

// PushManager wants the applicationServerKey as a Uint8Array of the raw bytes
// behind the base64url-encoded VAPID public key.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

type Support = "checking" | "supported" | "unsupported";

export function NotificationsSetup() {
  const [support, setSupport] = useState<Support>("checking");
  const [isStandalone, setIsStandalone] = useState(true);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [subscribed, setSubscribed] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: "info" | "error" | "success"; text: string } | null>(null);

  useEffect(() => {
    const supported =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    setSupport(supported ? "supported" : "unsupported");
    if (!supported) return;

    // On iOS, Web Push only works when the app is installed to the Home Screen
    // (running standalone). In a normal Safari tab, subscribe() is blocked.
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsStandalone(standalone);
    setPermission(Notification.permission);

    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub))
      .catch(() => {});
  }, []);

  async function enable() {
    setPending(true);
    setMessage(null);
    try {
      if (!VAPID_PUBLIC_KEY) {
        throw new Error("Missing NEXT_PUBLIC_VAPID_PUBLIC_KEY - set it in the environment and redeploy.");
      }
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        throw new Error(
          perm === "denied"
            ? "Notifications are blocked. Enable them for this app in your device settings, then try again."
            : "Notification permission was not granted."
        );
      }

      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }

      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") throw new Error(json.error ?? "Failed to save subscription");

      setSubscribed(true);
      setMessage({ kind: "success", text: "Notifications enabled on this device." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to enable notifications" });
    } finally {
      setPending(false);
    }
  }

  async function disable() {
    setPending(true);
    setMessage(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setSubscribed(false);
      setMessage({ kind: "info", text: "Notifications disabled on this device." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to disable notifications" });
    } finally {
      setPending(false);
    }
  }

  async function sendTest() {
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const json = await res.json();
      if (!res.ok || json.status !== "OK") throw new Error(json.error ?? "Failed to send test");
      if (json.sent === 0) {
        setMessage({
          kind: "error",
          text: "No active subscriptions received it. Enable notifications on this device first.",
        });
      } else {
        setMessage({ kind: "success", text: `Test push sent to ${json.sent} device(s). Watch for it now.` });
      }
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to send test" });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <span className="text-sm font-medium">Budget alert notifications</span>

      {support === "unsupported" && (
        <p className="text-sm text-amber-600">
          This browser doesn&apos;t support Web Push. On iPhone, open the installed Sikka app from your Home Screen.
        </p>
      )}

      {support === "supported" && !isStandalone && (
        <p className="text-sm text-amber-600">
          On iPhone, notifications only work from the installed app. Add Sikka to your Home Screen (Share → Add to
          Home Screen) and open it from there, then enable below.
        </p>
      )}

      {support === "supported" && (
        <div className="flex flex-wrap items-center gap-2">
          {!subscribed ? (
            <button
              type="button"
              onClick={enable}
              disabled={pending}
              className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {pending ? "Working…" : "Enable notifications"}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={sendTest}
                disabled={pending}
                className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {pending ? "Working…" : "Send test notification"}
              </button>
              <button
                type="button"
                onClick={disable}
                disabled={pending}
                className="rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
              >
                Disable
              </button>
            </>
          )}
        </div>
      )}

      {message && (
        <span
          className={`text-xs ${
            message.kind === "error"
              ? "text-red-600"
              : message.kind === "success"
                ? "text-emerald-600"
                : "text-zinc-500"
          }`}
        >
          {message.text}
        </span>
      )}
    </div>
  );
}
