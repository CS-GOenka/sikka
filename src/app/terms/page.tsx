import type { Metadata } from "next";
import { LegalPage, Section } from "@/app/legal";

export const metadata: Metadata = {
  title: "Terms of Service · Sikka",
  description: "Terms for using Sikka.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="15 September 2026">
      <Section heading="What Sikka is">
        <p>
          Sikka is a private, single-user application. It is not offered to the public and there are
          no accounts.
        </p>
      </Section>

      <Section heading="No warranty">
        <p>
          Sikka is provided as-is, without warranty of any kind. Its figures come from automated
          parsing of bank notifications and may be incomplete or incorrect. They are not a
          substitute for official bank statements.
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          <a className="text-[var(--sk-accent-ink)] underline" href="mailto:saurabhgoenka10ism@gmail.com">
            saurabhgoenka10ism@gmail.com
          </a>
        </p>
      </Section>
    </LegalPage>
  );
}
