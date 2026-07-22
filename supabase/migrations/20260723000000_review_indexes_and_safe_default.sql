-- Partial indexes so /review's needs_category_review OR starred lookup
-- stays fast regardless of total table size (Postgres can BitmapOr these).
create index if not exists transactions_needs_category_review_idx
  on transactions (id) where needs_category_review;
create index if not exists transactions_starred_idx
  on transactions (id) where starred;

-- Speeds up /transactions' "type != ignored" filter.
create index if not exists transactions_type_idx
  on transactions (type);

-- Fail-safe default: if a row is never successfully categorized (e.g. the
-- categorization update itself fails, as happened during the 2-year bulk
-- load), it now defaults to visible in the review queue instead of
-- silently invisible.
alter table transactions
  alter column needs_category_review set default true;
