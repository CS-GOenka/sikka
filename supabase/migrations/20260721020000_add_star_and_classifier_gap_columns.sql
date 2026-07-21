alter table transactions
  add column starred boolean not null default false,
  add column classifier_gap_reported boolean not null default false,
  add column classifier_gap_comment text;
