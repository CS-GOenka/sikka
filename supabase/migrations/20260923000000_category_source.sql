-- How this transaction's category was decided.
--
-- Nothing recorded it before, and the absence was load-bearing: an audit of
-- the 197 manual merchant_categories rows could only infer whether a category
-- was chosen for THIS transaction or inherited from a decision made about a
-- different one, by comparing transactions.created_at against
-- merchant_categories.updated_at. That inference breaks the moment a cache row
-- is rewritten - updated_at moves, and every earlier inheritance retroactively
-- reads as a human choice.
--
--   manual  a person picked this category for this transaction
--   cache   inherited from merchant_categories, no person involved
--   rule    a hardcoded branch (paan shops, investments, self-transfer)
--   llm     the model chose it
--
-- Null means undeterminable, and most of the table will stay null: the 3,311
-- rows already here were categorised before anything recorded why.
alter table transactions add column if not exists category_source text;

alter table transactions drop constraint if exists transactions_category_source_check;
alter table transactions add constraint transactions_category_source_check
  check (category_source is null or category_source in ('manual', 'cache', 'rule', 'llm'));

comment on column transactions.category_source is
  'How category_id was assigned: manual | cache | rule | llm. Null where it was never recorded.';
