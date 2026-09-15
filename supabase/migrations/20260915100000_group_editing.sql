-- Editing a group in place: renaming it, changing who is in it and for how
-- much, and hiding its name.
--
-- hide_name is a display choice, not a privacy control. A group called
-- "Divorce lawyer" or "Mum's surgery" is legible to anyone glancing at the
-- phone, and the fix is to show what it was and what it cost - the category
-- and the net - rather than what it was called. The name is still stored, and
-- the transactions inside it are untouched and still named on /transactions:
-- this hides a label on two screens, and is not a security boundary.
alter table settlement_groups
  add column if not exists hide_name boolean not null default false;

-- Undo has to cover the two edits that destroy something. Changing a share
-- overwrites the old number and removing a person takes their line away; both
-- are a single click and neither leaves the previous value anywhere. Renaming
-- and adding a person are left out deliberately - the old name is still on
-- screen to retype, and an added person is removed the same way they arrived.
alter table settlement_undo
  drop constraint if exists settlement_undo_action_check;
alter table settlement_undo
  add constraint settlement_undo_action_check
  check (action in ('ungroup', 'settle', 'unsettle', 'share', 'remove-person'));

-- What the row looked like before, as text so one column serves every action
-- rather than a nullable column per shape: the previous share for 'share', and
-- the removed person's name/share/status as JSON for 'remove-person'. Null for
-- the three original actions, which reverse without needing a stored value.
alter table settlement_undo
  add column if not exists prev_value text;
