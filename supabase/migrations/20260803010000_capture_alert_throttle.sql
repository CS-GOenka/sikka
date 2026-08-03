-- Throttle for the capture-outage push so frequent heartbeat checks (GitHub
-- Actions every ~2h) don't send a duplicate alert every run during a sustained
-- outage. The capture-check endpoint only pushes if the last alert was more
-- than a few hours ago.
alter table settings
  add column if not exists last_capture_alert_at timestamptz;
