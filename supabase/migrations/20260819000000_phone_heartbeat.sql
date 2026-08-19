-- Heartbeat for the iPhone Shortcuts automations. They POST /api/heartbeat
-- every ~30 minutes; if this goes stale the SMS-capture Shortcut has likely
-- died silently, which is the failure mode that loses transactions outright
-- (the Mac reconcile can only re-send what actually reached chat.db).
alter table settings
  add column if not exists last_phone_heartbeat timestamptz;

-- Throttle for the missing-ping push, mirroring last_capture_alert_at. The
-- check runs every ~30 minutes so a sustained outage would otherwise re-push
-- on every run.
alter table settings
  add column if not exists last_phone_heartbeat_alert_at timestamptz;
