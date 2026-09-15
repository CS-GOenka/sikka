/**
 * The Gmail REST surface this app uses. Read-only calls, all of them.
 *
 * Gmail meters by "quota units per minute per user" and `messages.get` costs 5.
 * Tripping that limit returns 403 for the rest of the minute on EVERY endpoint,
 * including cheap list calls - during the 24-month backfill a 15-way concurrent
 * fetch lost 947 of 1,585 messages that way. So backoff lives in the one
 * function every call goes through, not only around the expensive ones.
 */
import type { MessagePart } from "@/lib/gmail/body";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_ATTEMPTS = 6;

export async function gmailFetch<T>(
  path: string,
  params: Record<string, string | number | string[] | undefined>,
  accessToken: string
): Promise<T> {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.set(k, String(v));
  }

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as T;

    const throttled = (res.status === 403 || res.status === 429) && /quota|rate limit/i.test(text);
    if (throttled && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 800, 20000) + Math.random() * 500));
      continue;
    }
    const err = new Error(`Gmail ${path} ${res.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
}

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}

export const getProfile = (token: string) => gmailFetch<GmailProfile>("profile", {}, token);

interface MessageListPage {
  messages?: { id: string }[];
  nextPageToken?: string;
}

/** Every message id matching a query, following pageToken to the end. */
export async function listMessageIds(q: string, token: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gmailFetch<MessageListPage>("messages", { q, maxResults: 500, pageToken }, token);
    for (const m of page.messages ?? []) ids.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

export interface GmailMessage {
  id: string;
  internalDate: string;
  historyId: string;
  payload?: MessagePart & { headers?: { name: string; value: string }[] };
}

export const getMessage = (id: string, token: string) =>
  gmailFetch<GmailMessage>(`messages/${id}`, { format: "full" }, token);

interface HistoryPage {
  history?: { messagesAdded?: { message: { id: string } }[] }[];
  nextPageToken?: string;
  historyId?: string;
}

/** Raised when Gmail will not accept the stored cursor. */
export class HistoryTooOldError extends Error {
  constructor(readonly startHistoryId: string, readonly cause: string) {
    super(`Gmail rejected startHistoryId ${startHistoryId}: ${cause}`);
    this.name = "HistoryTooOldError";
  }
}

/**
 * Message ids added since `startHistoryId`.
 *
 * Gmail keeps roughly a week of history and is under no obligation to keep even
 * that. An expired cursor comes back as 404, and sometimes as a 400 complaining
 * about the id - both mean the same thing operationally, so both are folded into
 * HistoryTooOldError for the caller to answer with a date-range query instead.
 * Treating this as a generic failure would leave the poller retrying a cursor
 * that can never work again.
 */
export async function listAddedMessageIds(startHistoryId: string, token: string): Promise<string[]> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  try {
    do {
      const page = await gmailFetch<HistoryPage>(
        "history",
        { startHistoryId, historyTypes: "messageAdded", maxResults: 500, pageToken },
        token
      );
      for (const h of page.history ?? []) {
        for (const added of h.messagesAdded ?? []) ids.add(added.message.id);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (err) {
    const status = (err as { status?: number }).status;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 404 || (status === 400 && /historyId|startHistoryId/i.test(message))) {
      throw new HistoryTooOldError(startHistoryId, message);
    }
    throw err;
  }
  return [...ids];
}
