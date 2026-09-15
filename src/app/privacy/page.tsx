import type { Metadata } from "next";
import { LegalPage, Section } from "@/app/legal";

export const metadata: Metadata = {
  title: "Privacy Policy · Sikka",
  description: "How Sikka handles data.",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="15 September 2026">
      <Section heading="Who this is for">
        <p>
          Sikka is a personal finance app built and operated by one individual for their own use.
          There are no other users.
        </p>
      </Section>

      <Section heading="Data accessed">
        <p>
          With the operator&apos;s consent, Sikka reads transaction alert emails from the
          operator&apos;s own Gmail account using read-only access (<code>gmail.readonly</code>). It
          cannot send, modify or delete email. It reads only messages matching bank transaction
          alerts.
        </p>
      </Section>

      <Section heading="How the data is used">
        <p>
          The amount, date, merchant and card identifier are stored in a private database and used
          only to show the operator their own spending analytics.
        </p>
      </Section>

      <Section heading="Limited Use">
        <p>
          Sikka&apos;s use of information received from Google APIs adheres to the Google API
          Services User Data Policy, including the Limited Use requirements. Google user data is not
          transferred to any third party, is not used for advertising, and is not used to train any
          model.
        </p>
      </Section>

      <Section heading="Retention and revoking access">
        <p>
          Data is kept until the operator deletes it. Access can be revoked at any time from the
          Google Account permissions page.
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
