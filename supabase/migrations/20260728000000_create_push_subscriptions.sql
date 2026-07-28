-- Web Push subscriptions for budget-alert notifications. One row per
-- browser/PWA push endpoint. endpoint is unique so re-subscribing the same
-- device upserts rather than duplicating. p256dh + auth are the encryption
-- keys the browser hands back from PushManager.subscribe().
create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
