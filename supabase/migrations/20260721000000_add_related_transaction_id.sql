alter table transactions
  add column related_transaction_id bigint references transactions(id);
