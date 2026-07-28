-- Stage 2 (daily budget alerts) schema.

-- Configurable day boundary: "today" runs from day_reset_hour to
-- day_reset_hour (IST), not midnight to midnight. Default 3 = 3 AM.
alter table settings
  add column if not exists day_reset_hour int not null default 3;

-- Whether transactions in a category count toward daily spend. Uncategorized
-- debits count by default (handled in code); this flag lets specific
-- categories opt out.
alter table categories
  add column if not exists counts_as_spend boolean not null default true;

-- Investments (buying assets) and the Ignore action bucket are not
-- consumption spend, so they don't count toward the daily budget.
update categories set counts_as_spend = false where name in ('Investments', 'Ignore');
