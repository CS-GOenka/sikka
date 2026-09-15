-- The Gmail message a transaction came from, and the guarantee that one alert
-- can only ever produce one transaction.
--
-- Nullable, and it will stay null for the 3,279 rows already here: they were
-- captured over SMS and have no email behind them. Only rows ingested from
-- email will carry a value, which is why this cannot be NOT NULL and why the
-- unique index has to tolerate nulls - Postgres treats nulls as distinct, so
-- any number of SMS-captured rows coexist happily.
--
-- The constraint is the point of this migration, not the column. Email ingest
-- re-reads a rolling window of the mailbox on every run, so the same alert is
-- seen again and again; without a database-level guarantee, one retry, one
-- overlapping window or one concurrent run mints a second transaction for a
-- charge that happened once. Application-level duplicate checks already exist
-- for SMS and both of them fail open by design (losing a message is worse than
-- storing a duplicate). That trade is right for SMS, where the alert arrives
-- once and is gone. It is wrong for email, where the alert is still sitting in
-- the mailbox and will be re-read in fifteen minutes - so email gets the
-- opposite policy, enforced where it cannot be bypassed.
alter table transactions add column if not exists gmail_message_id text;

create unique index if not exists transactions_gmail_message_id_key
  on transactions (gmail_message_id);

comment on column transactions.gmail_message_id is
  'Gmail message id this transaction was ingested from. Null for SMS-captured rows. Unique: one alert, one transaction.';
