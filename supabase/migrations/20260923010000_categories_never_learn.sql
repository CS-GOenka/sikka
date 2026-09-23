-- Categories that describe the occasion, not the merchant.
--
-- The merchant cache assumes a merchant has one category. For most of the tree
-- that holds - a pharmacy is always Pharmacy. For some categories it is exactly
-- backwards, and teaching the cache from a correction into one of them
-- generalises a one-off decision to every future charge from that payee.
--
-- Measured across this account, by asking how many of a category's merchant
-- keys ALSO appear under a different category:
--
--     Party            100%   (4 of 4 keys)
--     Appliances        67%
--     Ignore            57%
--     Moving In         29%
--     Gifts             33%
--   ... against ...
--     Family             0%
--     Friends            1%
--     Restaurant/Cafe    1%
--     Hospital/Doctor    0%
--
-- The separation is not marginal. One merchant, `amazon pay in e`, is filed
-- under six categories at once - Online, Movies, Car, Mattress, Amazon and
-- Appliances - because what was bought differs every time. `mohammed` spans
-- Smoke, Party and Moving In. `blinkit` spans Quick Commerce, Party and Ignore.
--
-- A correction into a never_learn category still corrects the transaction. It
-- just does not write merchant_categories, so it applies to the row in front of
-- the user and nothing else.
alter table categories add column if not exists never_learn boolean not null default false;

comment on column categories.never_learn is
  'True when this category describes the occasion rather than the merchant. Corrections into it never write merchant_categories.';

-- Ignore: an action, not a property of a merchant. Dismissing one charge must
-- never mean dismissing every future charge from that payee - which is exactly
-- what happened to Blinkit on 15 September 2026.
update categories set never_learn = true where name = 'Ignore';

-- House RFS and its children: a one-off house move. "Amazon" here means "an
-- Amazon order for the move", not "Amazon is a house purchase".
update categories set never_learn = true
where name = 'House RFS'
   or parent_id = (select id from categories where name = 'House RFS');

-- Gifts and its children: a gift is defined by the occasion and the recipient.
-- Its children are people's names, which cannot be merchant properties at all.
update categories set never_learn = true
where name = 'Gifts'
   or parent_id = (select id from categories where name = 'Gifts');
