-- Landing table for ICICI alerts parsed out of Gmail.
--
-- Deliberately separate from `transactions`. Email is a second, newer channel
-- for the same events the SMS pipeline already captures, and until the two have
-- been reconciled a parsed email is a claim about a transaction, not a
-- transaction. Nothing here feeds spend.
--
-- payee_email is stored apart from anything the SMS side produced: the email
-- carries the merchant name untruncated ("SWIGGY PVT LTD FOOD1") where the SMS
-- carries a 15-character stump ("Swiggy Pvt Ltd"), and collapsing them before
-- deciding which is authoritative would destroy the evidence for that decision.
create table if not exists gmail_staging (
  id bigserial primary key,
  -- Gmail's immutable message id. Unique so a re-run updates rather than
  -- duplicates; this table is expected to be rebuilt repeatedly while the
  -- parser is still being trusted.
  gmail_message_id text not null unique,
  -- Milliseconds since the UTC epoch, straight from Gmail's internalDate.
  -- Authoritative for time. The body's own timestamp is deliberately NOT
  -- parsed: card alerts print a 12-hour clock with no meridiem, so "04:19:02"
  -- is 04:19 or 16:19 with nothing in the message to say which.
  internal_date bigint not null,
  amount numeric,
  card_last4 text,
  -- The merchant exactly as the email gives it, minus the sentence-ending
  -- period after "Info:".
  payee_email text,
  available_limit numeric,
  -- Fail closed. Only an alert that positively matches the success template
  -- is 'success'; everything else is quarantined with a reason and is never
  -- treated as a completed transaction.
  status text not null default 'quarantine' check (status in ('success', 'quarantine')),
  quarantine_reason text,
  raw_body text,
  parsed_at timestamptz not null default now()
);

create index if not exists gmail_staging_internal_date_idx
  on gmail_staging (internal_date desc);
create index if not exists gmail_staging_quarantine_idx
  on gmail_staging (status) where status = 'quarantine';
