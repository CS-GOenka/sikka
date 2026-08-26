-- Group settlements: shared costs I fronted, and pots I merely passed through.
--
-- One model covers both. A dinner where I paid Rs 5,000 and four people owe me
-- Rs 1,000 each is a group with four lines; a poker night where money came in
-- and went back out is a group with none. The situation decides the behaviour,
-- not a mode flag.
--
-- The point of the model is the spend arithmetic. A grouped transaction stops
-- counting on its own and the group contributes one net figure instead:
--
--     net = sum(debits) - sum(credits) - sum(person shares)
--
-- Dinner: 5000 - 0 - 4000 = Rs 1,000 of real spend, the rest pass-through.
-- Poker:  4650 - 5000 - 0 = -Rs 350, a net gain that reduces spend.

create table if not exists settlement_groups (
  id bigserial primary key,
  name text not null,
  -- Derived from the lines and rewritten whenever they change: a group with no
  -- open lines is closed. Stored rather than computed on read so the groups
  -- list can be filtered and ordered by it.
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists settlement_lines (
  id bigserial primary key,
  group_id bigint not null references settlement_groups(id) on delete cascade,
  person text not null,
  -- What this person owes me. Always subtracted from the group's spend,
  -- settled or not: their share was pass-through from the moment I paid it,
  -- and being repaid changes who is holding the money, not whether I spent it.
  share numeric not null check (share >= 0),
  status text not null default 'open' check (status in ('open', 'settled')),
  settled_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists settlement_lines_group_idx on settlement_lines (group_id);
create index if not exists settlement_lines_open_idx on settlement_lines (status) where status = 'open';

-- At most one group per transaction, which a single nullable column enforces
-- by construction. Deleting a group releases its transactions rather than
-- destroying them.
alter table transactions
  add column if not exists settlement_group_id bigint references settlement_groups(id) on delete set null;

create index if not exists transactions_settlement_group_idx
  on transactions (settlement_group_id)
  where settlement_group_id is not null;
