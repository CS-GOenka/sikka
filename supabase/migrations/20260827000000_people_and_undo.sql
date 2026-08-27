-- Remembered people, and undo for settlement actions.

-- Every person ever added to a group, so a regular can be added with one tap.
-- Matched case-insensitively: "asha" and "Asha" are one person, and adding an
-- existing name reuses its row rather than making a second.
create table if not exists settlement_people (
  id bigserial primary key,
  name text not null,
  use_count integer not null default 1,
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index if not exists settlement_people_name_key
  on settlement_people (lower(name));

-- Ungrouping no longer destroys a group; it marks it gone.
--
-- This is what makes undo exact rather than reconstructive. The row, its id,
-- its name, its category, its lines and its transactions' membership all stay
-- exactly as they were, and the only thing that changes is this timestamp - so
-- reversing is clearing one field, with nothing to rebuild and nothing that
-- can come back subtly different. A hard delete would have had to recreate the
-- group and its lines, and they would return with new ids.
alter table settlement_groups
  add column if not exists deleted_at timestamptz;

create index if not exists settlement_groups_live_idx
  on settlement_groups (deleted_at)
  where deleted_at is null;

-- What was done, so the last action can be offered back.
--
-- Deliberately records only which action touched which row. The previous
-- values are not journalled because nothing is destroyed to begin with:
-- reversing an ungroup clears deleted_at, and reversing a settle flips the
-- line back and recomputes the group's status from its lines the same way
-- every other write does. A journal holding its own copy of the prior state
-- would be a second source of truth that could disagree with the first.
create table if not exists settlement_undo (
  id bigserial primary key,
  action text not null check (action in ('ungroup', 'settle', 'unsettle')),
  group_id bigint references settlement_groups(id) on delete cascade,
  line_id bigint references settlement_lines(id) on delete cascade,
  label text not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);

create index if not exists settlement_undo_pending_idx
  on settlement_undo (created_at desc)
  where undone_at is null;
