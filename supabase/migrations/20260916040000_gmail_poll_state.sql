-- Where the poller keeps its place, and what it did each time it ran.
--
-- gmail_sync_state is a single row. Gmail's incremental sync is a cursor: ask
-- history.list for everything since historyId X and it answers with the changes
-- plus a new X. Lose the cursor and the only honest fallback is a date-range
-- query, which is more expensive and can only see as far back as it is told to
-- look - so the cursor is worth storing durably rather than in memory that a
-- serverless function does not keep.
--
-- gmail_poll_runs is the log, one row per run, written whether the run succeeded
-- or failed. A poller that silently does nothing looks exactly like a poller
-- with nothing to do; the difference only shows up if every run leaves a record.
-- history_id_before and history_id_after are both stored because a run that
-- fetched nothing and a run whose cursor did not move are different problems.
create table if not exists gmail_sync_state (
  id smallint primary key default 1 check (id = 1),
  last_history_id text,
  updated_at timestamptz not null default now()
);

insert into gmail_sync_state (id) values (1) on conflict (id) do nothing;

create table if not exists gmail_poll_runs (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  duration_ms integer,
  emails_fetched integer not null default 0,
  staged integer not null default 0,
  inserted integer not null default 0,
  skipped_as_duplicate integer not null default 0,
  quarantined integer not null default 0,
  ambiguous integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  history_id_before text,
  history_id_after text,
  -- True when the stored cursor was refused and the run fell back to a date
  -- range. Worth a column rather than a log line: if this is true on every run,
  -- the cursor is never being saved and the "incremental" sync is not one.
  used_timestamp_fallback boolean not null default false,
  fallback_reason text
);

create index if not exists gmail_poll_runs_ran_at_idx on gmail_poll_runs (ran_at desc);

comment on table gmail_sync_state is 'Single-row cursor for Gmail incremental sync.';
comment on table gmail_poll_runs is 'One row per /api/gmail/poll invocation, written even when the run fails.';
