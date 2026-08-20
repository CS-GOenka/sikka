-- Execution record for the capture-health check itself.
--
-- Diagnosing a missed alert previously meant inferring whether the scheduler
-- had run at all, from the side effects of alerts that did fire - there was no
-- direct evidence. This column is written on every invocation, so "is the cron
-- calling us?" becomes a single lookup.
--
-- It also enables a meta-monitor: if this goes stale, the thing that raises
-- every other alert has stopped, and no other alert can be trusted to arrive.
alter table settings
  add column if not exists last_capture_check_at timestamptz;
