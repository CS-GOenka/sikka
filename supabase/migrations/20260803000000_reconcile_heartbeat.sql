-- Heartbeat for the Mac reconcile cron. It pings after every successful run;
-- the app shows a warning banner (and the cron can push an alert) if this goes
-- stale, so an ingestion outage can never again go unnoticed for days.
alter table settings
  add column if not exists last_reconcile_ping timestamptz;
