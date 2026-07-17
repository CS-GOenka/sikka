create table if not exists raw_messages (
  id bigint generated always as identity primary key,
  message text not null,
  created_at timestamptz not null default now()
);
