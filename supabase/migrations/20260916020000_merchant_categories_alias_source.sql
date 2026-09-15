-- Allow confidence_source='alias': a category inherited from another key rather
-- than observed on this one.
--
-- The email alert and the SMS alert for the same charge normalise to different
-- cache keys, because the SMS cuts the merchant name at 15 characters. Seeding
-- the email's key with its SMS twin's category is the cheap fix, but it must not
-- masquerade as evidence - 'alias' records that nothing was ever seen under this
-- spelling, so a later real observation (or a human) can displace it without
-- anyone having to wonder where the value came from.
--
-- The existing CHECK is dropped and rebuilt because Postgres has no way to add a
-- value to one. The four values below are every value the codebase writes and
-- every value present in the table today:
--
--   manual 189, llm 429, mandate 7, hardcoded 5   (630 rows, 16 Sep 2026)
--
-- If the live constraint permitted some fifth value that nothing has ever
-- written, rebuilding drops it. That was checked against both the data and the
-- code before writing this, and there is no such value.
alter table merchant_categories drop constraint if exists merchant_categories_confidence_source_check;
alter table merchant_categories add constraint merchant_categories_confidence_source_check
  check (confidence_source in ('manual', 'llm', 'mandate', 'hardcoded', 'alias'));
