-- Foreign-currency card transactions in INR.
--
-- ICICI card transactions abroad arrive as an SMS quoting only the foreign
-- amount ("USD 23.60 spent using ICICI Bank Card XX2003"). Every spend query in
-- this app filters currency = 'INR', so those rows were silently absent from
-- budgets, the dashboard and every total - present in the table, invisible in
-- the numbers.
--
-- The fix converts at ingest and stores the result in `amount`, with
-- `currency` set to 'INR'. That is deliberate: it means computeTodaySpend, the
-- dashboard windows, the budget push and every chart keep working untouched,
-- with no per-query conversion and no second amount column for them to forget
-- about. The original figures move into the columns below rather than being
-- lost, so the conversion stays auditable and reversible.

-- Cached exchange rates, so a given currency/date is fetched at most once and
-- the app keeps working when the provider is unreachable.
create table if not exists fx_rates (
  -- The date we asked for, which is the transaction's own date.
  rate_date date not null,
  currency text not null,
  rate numeric not null check (rate > 0),
  -- The date the provider actually priced. ECB does not publish at weekends or
  -- on holidays, so a Saturday request is answered with Friday's rate; storing
  -- both keeps "which rate did we use" answerable later.
  effective_date date not null,
  provider text not null,
  fetched_at timestamptz not null default now(),
  primary key (currency, rate_date)
);

alter table transactions
  -- The foreign amount exactly as the SMS quoted it.
  add column if not exists original_amount numeric,
  add column if not exists original_currency text,
  -- The mid-market rate applied, and the date it was priced on.
  add column if not exists fx_rate numeric,
  add column if not exists fx_rate_date date,
  -- Set when a rate could not be obtained. The row keeps its foreign amount and
  -- stays out of INR spend until a retry converts it - flagged rather than
  -- dropped, and never guessed at.
  add column if not exists fx_pending boolean not null default false;

-- The retry path scans for these, so keep it cheap. Partial: converted rows are
-- the overwhelming majority and are never scanned this way.
create index if not exists transactions_fx_pending_idx
  on transactions (fx_pending)
  where fx_pending = true;
