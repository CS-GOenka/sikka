create table if not exists settings (
  id integer primary key default 1,
  daily_budget numeric,
  updated_at timestamptz not null default now()
);
