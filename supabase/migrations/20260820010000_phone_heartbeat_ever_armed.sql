-- Distinguishes "the monitor has never been set up" from "the monitor was set
-- up and its heartbeat record has since vanished".
--
-- Both look identical in last_phone_heartbeat: NULL. The check suppresses the
-- alert on NULL so it stays quiet before first setup - which meant that if the
-- field was ever cleared afterwards (a manual edit, a bad restore, a test that
-- reset it), the whole alarm disarmed itself silently, and a genuine
-- cancelled-automations test produced no alert and no error. That happened.
--
-- With this flag the two cases separate: never armed stays quiet, previously
-- armed becomes an anomaly worth shouting about.
alter table settings
  add column if not exists phone_heartbeat_ever_armed boolean not null default false;

-- A heartbeat currently on record is proof the monitor has been armed, so the
-- flag must not start false for an already-live setup - that would reopen the
-- exact hole this closes until the next ping happened to land.
update settings
  set phone_heartbeat_ever_armed = true
  where last_phone_heartbeat is not null;
