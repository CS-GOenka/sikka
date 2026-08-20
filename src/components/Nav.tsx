import Link from "next/link";

const LINKS = [
  { href: "/transactions", label: "Transactions" },
  { href: "/capture-check", label: "Capture Check" },
  { href: "/review", label: "Review" },
  { href: "/classifier-gaps", label: "Classifier Gaps" },
  { href: "/cleanup", label: "Cleanup" },
  { href: "/categories", label: "Categories" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  return (
    // overflow-x-auto keeps the nav's own overflow inside the nav. With seven
    // links it is wider than a phone screen, and without this the whole
    // document scrolls horizontally - which made /transactions look like it
    // still had the table-scrolling problem even once the table fit.
    <nav className="flex gap-4 overflow-x-auto border-b border-zinc-200 px-4 py-3 text-sm font-medium dark:border-zinc-800">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="shrink-0 whitespace-nowrap text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
