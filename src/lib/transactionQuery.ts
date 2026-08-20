// Shared parsing/serialising of the /transactions list state (filters, sort,
// page). Lives in one place because the server page and the client filter
// panel must agree exactly on the URL shape - a mismatch would silently drop a
// filter rather than error.

export const SORT_KEYS = ["date", "amount", "category", "payee"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

// Maps a sort key to the PostgREST order target. Two of these are columns on
// embedded resources, which PostgREST supports for to-one embeds - verified
// against this database rather than assumed.
export const SORT_COLUMN: Record<SortKey, string> = {
  date: "raw_messages(phone_received_at)",
  amount: "amount",
  category: "categories(name)",
  payee: "payee",
};

export const DEFAULT_SORT: SortKey = "date";
export const DEFAULT_DIR: SortDir = "desc";

// Sentinel for "has no category". category_id is nullable, so an id list alone
// can never express it.
export const UNCATEGORIZED = "none";

export interface TransactionFilters {
  categories: string[]; // category ids as strings, plus possibly UNCATEGORIZED
  methods: string[];
  types: string[];
  accountTypes: string[];
  statuses: string[];
  amountMin: string;
  amountMax: string;
  dateFrom: string; // yyyy-mm-dd
  dateTo: string; // yyyy-mm-dd
  payee: string;
}

export const EMPTY_FILTERS: TransactionFilters = {
  categories: [],
  methods: [],
  types: [],
  accountTypes: [],
  statuses: [],
  amountMin: "",
  amountMax: "",
  dateFrom: "",
  dateTo: "",
  payee: "",
};

export interface ListState {
  filters: TransactionFilters;
  sort: SortKey;
  dir: SortDir;
  page: number;
}

type ParamValue = string | string[] | undefined;
type Params = Record<string, ParamValue>;

function one(v: ParamValue): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

function list(v: ParamValue): string[] {
  const raw = one(v);
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseListState(params: Params): ListState {
  const sortRaw = one(params.sort) as SortKey;
  const dirRaw = one(params.dir);
  const pageNum = parseInt(one(params.page) || "1", 10);
  return {
    filters: {
      categories: list(params.cat),
      methods: list(params.method),
      types: list(params.type),
      accountTypes: list(params.acct),
      statuses: list(params.status),
      amountMin: one(params.amin),
      amountMax: one(params.amax),
      dateFrom: one(params.dfrom),
      dateTo: one(params.dto),
      payee: one(params.q),
    },
    sort: SORT_KEYS.includes(sortRaw) ? sortRaw : DEFAULT_SORT,
    dir: dirRaw === "asc" ? "asc" : DEFAULT_DIR,
    page: Number.isFinite(pageNum) && pageNum > 0 ? pageNum : 1,
  };
}

export function hasAnyFilter(f: TransactionFilters): boolean {
  return (
    f.categories.length > 0 ||
    f.methods.length > 0 ||
    f.types.length > 0 ||
    f.accountTypes.length > 0 ||
    f.statuses.length > 0 ||
    f.amountMin !== "" ||
    f.amountMax !== "" ||
    f.dateFrom !== "" ||
    f.dateTo !== "" ||
    f.payee.trim() !== ""
  );
}

export function activeFilterCount(f: TransactionFilters): number {
  let n = 0;
  if (f.categories.length) n++;
  if (f.methods.length) n++;
  if (f.types.length) n++;
  if (f.accountTypes.length) n++;
  if (f.statuses.length) n++;
  if (f.amountMin !== "" || f.amountMax !== "") n++;
  if (f.dateFrom !== "" || f.dateTo !== "") n++;
  if (f.payee.trim() !== "") n++;
  return n;
}

// Builds the querystring. Page is deliberately omitted when 1 and sort when
// default, so a plain /transactions URL stays clean and shareable.
export function buildQuery(state: {
  filters: TransactionFilters;
  sort?: SortKey;
  dir?: SortDir;
  page?: number;
}): string {
  const f = state.filters;
  const p = new URLSearchParams();
  if (f.categories.length) p.set("cat", f.categories.join(","));
  if (f.methods.length) p.set("method", f.methods.join(","));
  if (f.types.length) p.set("type", f.types.join(","));
  if (f.accountTypes.length) p.set("acct", f.accountTypes.join(","));
  if (f.statuses.length) p.set("status", f.statuses.join(","));
  if (f.amountMin !== "") p.set("amin", f.amountMin);
  if (f.amountMax !== "") p.set("amax", f.amountMax);
  if (f.dateFrom !== "") p.set("dfrom", f.dateFrom);
  if (f.dateTo !== "") p.set("dto", f.dateTo);
  if (f.payee.trim() !== "") p.set("q", f.payee.trim());
  if (state.sort && state.sort !== DEFAULT_SORT) p.set("sort", state.sort);
  if (state.dir && state.dir !== DEFAULT_DIR) p.set("dir", state.dir);
  if (state.page && state.page > 1) p.set("page", String(state.page));
  const s = p.toString();
  return s ? `?${s}` : "";
}

// IST, matching every other date boundary in this app (budget days,
// formatReceived). A date-only filter value like "2026-08-19" means the whole
// of that IST day, so `to` is exclusive of the *next* day's midnight.
const IST_OFFSET_MS = 330 * 60 * 1000;

export function istDayStartUtc(yyyyMmDd: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0) - IST_OFFSET_MS).toISOString();
}

export function istDayEndUtc(yyyyMmDd: string): string | null {
  const start = istDayStartUtc(yyyyMmDd);
  if (!start) return null;
  return new Date(Date.parse(start) + 24 * 60 * 60 * 1000).toISOString();
}
