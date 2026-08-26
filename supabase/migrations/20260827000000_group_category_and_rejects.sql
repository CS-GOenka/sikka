-- Two additions.
--
-- 1. A settlement group's own category.
--
-- A group's daughters can be filed anywhere - a night out is part Food, part
-- Indulgence - but the parent is the thing that counts toward spend, so it
-- needs one category of its own rather than inheriting whichever daughter
-- happened to be largest. Daughters keep their categories as record.
alter table settlement_groups
  add column if not exists category_id bigint references categories(id) on delete set null;

-- 2. Share-sheet captures the ingest refused as duplicates.
--
-- The duplicate check runs before the raw_messages insert, so a rejected share
-- wrote nothing at all while the endpoint still answered OK - a hand-shared
-- transaction could vanish with nothing anywhere to say so. Rejections are now
-- recorded here and surfaced until answered, so a manual capture is never lost
-- silently.
create table if not exists rejected_captures (
  id bigserial primary key,
  message text not null,
  -- Parsed at rejection time, so the callout can name the transaction without
  -- re-classifying the message every time it renders.
  amount numeric,
  payee text,
  transaction_date date,
  -- What it was taken to be a duplicate of, for the "confirm duplicate" answer.
  matched_transaction_id bigint references transactions(id) on delete set null,
  reason text not null,
  created_at timestamptz not null default now(),
  -- Null while it still needs an answer.
  resolved_at timestamptz,
  resolution text check (resolution in ('captured', 'duplicate', 'expired'))
);

-- The callout scans for unanswered rejections on every page load, so keep it
-- cheap. Partial: answered rows are never scanned this way.
create index if not exists rejected_captures_unresolved_idx
  on rejected_captures (created_at desc)
  where resolved_at is null;
