import Image from "next/image";
import Link from "next/link";

/**
 * The app's mark. Links home, which also gives the header a way back to the
 * dashboard from any screen - previously only the profile menu offered that.
 *
 * The wordmark sits beside the coin rather than inside it: the icon alone is
 * the home-screen identity, but in-app the name is worth spelling out, and at
 * 28px the ₹ glyph reads as a symbol rather than as a brand on its own.
 */
export function SikkaLogo() {
  return (
    <Link href="/" aria-label="Sikka - go to dashboard" className="flex items-center gap-2">
      <Image src="/sikka-logo.svg" alt="" width={28} height={28} priority />
      <span className="text-[1.0625rem] font-semibold tracking-tight text-[var(--sk-ink)]">
        Sikka
      </span>
    </Link>
  );
}
