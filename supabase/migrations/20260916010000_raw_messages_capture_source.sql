-- Which writer put this message here.
--
-- Four senders POST to /api/ingest, and they mean different things, but until
-- now nothing recorded which one it was. isManualCapture() reads a `source`
-- field off the request body to decide receipt-time precedence and whether the
-- fingerprint duplicate check may run at all - and then throws that knowledge
-- away. So the single most load-bearing fact about a capture (was a human
-- holding the phone?) survives only for the length of one request.
--
--   shortcut   the iOS SMS automation, posting on arrival
--   reconcile  scripts/reconcile_messages.py, re-posting from chat.db later
--   manual     the iOS Share Sheet, a message shared by hand
--   email      Gmail ingest. Nothing writes this yet.
--
-- Nullable on purpose, and most rows will stay null. The backfill only labels
-- rows whose source is provable from data already stored; guessing here would
-- be worse than not knowing, because the value is meant to be evidence.
alter table raw_messages add column if not exists capture_source text;

alter table raw_messages drop constraint if exists raw_messages_capture_source_check;
alter table raw_messages add constraint raw_messages_capture_source_check
  check (capture_source is null or capture_source in ('shortcut', 'reconcile', 'manual', 'email'));

comment on column raw_messages.capture_source is
  'Which writer posted this message: shortcut | reconcile | manual | email. Null where it could not be determined.';
