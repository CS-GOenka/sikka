-- The figure the bank leaves at the end of an alert.
--
-- A credit card quotes the available credit limit, a savings account the
-- available balance. Different quantities, one column, because they serve one
-- purpose and are never weighed against each other: the duplicate fingerprint
-- pins card_or_account before this is consulted, so a limit is only ever
-- compared with another limit on the same card.
--
-- It exists to settle the one question nothing else in an SMS can. Two ₹340
-- Zepto orders on the same day and one ₹340 order captured twice are identical
-- in amount, date, card and merchant. They differ only in what the bank says is
-- left afterwards. Without this the fingerprint check had to choose between
-- collapsing real spend and letting duplicates through, and it chose - by
-- design - to let duplicates through, on the grounds that a visible duplicate
-- beats silently-lost money.
--
-- Null wherever the alert quoted nothing, which is most of them: 2,256 of 3,291
-- rows today, almost all savings-account UPI transfers. A null never vetoes
-- anything, so those rows keep exactly the behaviour they have now.
alter table transactions add column if not exists available_limit numeric;

comment on column transactions.available_limit is
  'Available credit limit (cards) or available balance (savings) quoted by the alert this row came from. Null when the alert quoted none. Used as a duplicate veto: two rows on one card reporting different figures cannot be the same charge.';
