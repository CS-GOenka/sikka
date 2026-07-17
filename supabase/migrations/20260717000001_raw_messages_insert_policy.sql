alter table raw_messages enable row level security;

create policy "Allow anon insert" on raw_messages
  for insert
  to anon
  with check (true);
