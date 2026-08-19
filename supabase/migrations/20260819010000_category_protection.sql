-- Protection flag for categories the app's own logic depends on. Independent
-- of counts_as_spend: every combination of the two is valid and meaningful
-- (a protected category can still count as spend, and an excluded category
-- need not be protected).
--
-- Protection blocks deletion only. Protected categories stay renamable.
alter table categories
  add column if not exists is_protected boolean not null default false;

-- Backfill the system-critical set.
--
-- 1. Anything already excluded from spend. Deleting one of these would
--    silently pull its transactions back into budget totals, since an
--    uncategorized debit counts as spend by default (see budget.ts).
update categories set is_protected = true where counts_as_spend = false;

-- 2. Categories the code looks up by literal name. Deleting any of these
--    breaks the lookup at runtime:
--      Investments      - lib/categorize.ts getInvestmentsCategoryId()
--      Indulgence       - lib/categorize.ts getIndulgenceCategoryId()
--      Person-to-Person - lib/categorize.ts, and app/cleanup/page.tsx which
--                         renders the whole /cleanup screen from its children
--      Ignore           - lib/gemini.ts ACTION_CATEGORY_NAMES, and the
--                         CategoryPicker "Actions" group
--
--    Person-to-Person still counts as spend, so rule 1 does not catch it -
--    name-dependence and spend-exclusion are different reasons to protect.
update categories set is_protected = true
  where name in ('Investments', 'Indulgence', 'Person-to-Person', 'Ignore');

-- Note on transfers: there is deliberately no transfer category to protect.
-- Transfers are modelled on the transaction itself (transactions.is_transfer,
-- with category_id left null) rather than as a category, so there is nothing
-- here for a transfer rule to point at.
