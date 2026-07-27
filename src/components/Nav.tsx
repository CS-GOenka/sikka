import Link from "next/link";

const LINKS = [
  { href: "/transactions", label: "Transactions" },
  { href: "/review", label: "Review" },
  { href: "/classifier-gaps", label: "Classifier Gaps" },
  { href: "/cleanup", label: "Cleanup" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  return (
    <nav className="flex gap-4 border-b border-zinc-200 px-4 py-3 text-sm font-medium dark:border-zinc-800">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
