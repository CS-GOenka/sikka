-- The merchant name as the email spelled it.
--
-- The two channels disagree about merchant names in a way that is not a defect
-- in either: the SMS cuts the field at 15 characters, the email carries roughly
-- 25 and includes the legal entity. "AMAZON PAY IN E COMMERCE" and
-- "Amazon Pay In E" are the same charge described by two senders, and 313 of the
-- 907 matched pairs differ once casing is ignored.
--
-- Keeping the email's version in its own column exists to stop three different
-- arguments from being settled by one field:
--
--   payee       what the merchant list and the transaction row display. For an
--               email-ingested row this is payee_email with any "UPI-<ref>-"
--               prefix stripped, because a one-time reference number is not a
--               merchant and must never appear in a list of places money went.
--   payee_email exactly what the bank wrote in the email, unedited. Provenance:
--               when the display name and the cache key disagree with each
--               other later, this is the thing that says what arrived.
--   the cache key (merchant_categories.payee) the SMS-shaped truncation, so one
--               merchant keeps one key across both channels. Keying on the full
--               email string instead produces 60 new keys rather than 5 for this
--               mailbox, splitting Swiggy across six of them.
--
-- Null for every SMS-captured row; there was no email.
alter table transactions add column if not exists payee_email text;

comment on column transactions.payee_email is
  'Merchant string exactly as the Gmail alert wrote it. Null for SMS-captured rows. Display uses payee; the cache key uses the SMS-shaped truncation.';
