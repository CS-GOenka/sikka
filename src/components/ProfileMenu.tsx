"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// The screens that used to be the top nav. The dashboard is now the app's
// front door, so everything else is something you go *to* from here. Grouped
// because the last two are maintenance tools rather than daily screens.
const PRIMARY = [
  { href: "/", label: "Dashboard" },
  { href: "/transactions", label: "Transactions" },
  { href: "/review", label: "Review" },
  { href: "/groups", label: "Grouped expenses" },
  { href: "/capture-check", label: "Capture Check" },
  { href: "/categories", label: "Categories" },
  { href: "/settings", label: "Settings" },
];

const MAINTENANCE = [
  { href: "/classifier-gaps", label: "Classifier Gaps" },
  { href: "/cleanup", label: "Cleanup" },
];

export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on Escape and on a click anywhere outside. Without the outside-click
  // handler the menu stays open behind the next tap on a phone, which reads as
  // the app having hung.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu"
        onClick={() => setOpen((v) => !v)}
        className="flex size-10 items-center justify-center rounded-full border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] text-[var(--sk-ink-2)] transition-colors active:bg-[var(--sk-accent-tint)]"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden className="size-5">
          <circle cx="12" cy="8.5" r="3.5" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-2xl border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] p-1.5 shadow-[0_12px_32px_-8px_rgba(28,25,23,0.18)]"
        >
          {PRIMARY.map((item) => (
            <MenuLink
              key={item.href}
              {...item}
              active={pathname === item.href}
              onNavigate={() => setOpen(false)}
            />
          ))}
          <div className="my-1.5 h-px bg-[var(--sk-hair)]" />
          {MAINTENANCE.map((item) => (
            <MenuLink
              key={item.href}
              {...item}
              active={pathname === item.href}
              onNavigate={() => setOpen(false)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Closes on the tap rather than on a pathname change, so tapping the screen
// you are already on dismisses the menu too.
function MenuLink({
  href,
  label,
  active,
  onNavigate,
}: {
  href: string;
  label: string;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      role="menuitem"
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`block rounded-xl px-3 py-2.5 text-[0.9375rem] transition-colors ${
        active
          ? "bg-[var(--sk-accent-tint)] font-semibold text-[var(--sk-accent-ink)]"
          : "text-[var(--sk-ink-2)] active:bg-[var(--sk-plane)]"
      }`}
    >
      {label}
    </Link>
  );
}
