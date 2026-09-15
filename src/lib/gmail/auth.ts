/**
 * Google OAuth for Gmail, read-only.
 *
 * Scope is gmail.readonly and nothing else. That grant cannot send, modify,
 * label or delete anything - the worst a bug here can do is read mail it had
 * no business reading, which is why the query that follows is pinned to two
 * sender addresses and their subjects rather than to a keyword.
 */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * The consent URL to open in a browser.
 *
 * access_type=offline and prompt=consent are both load-bearing. Without
 * offline, Google issues an access token only; without prompt=consent it
 * silently omits the refresh token on every authorisation after the first,
 * which looks like success right up until the access token expires an hour
 * later and there is nothing left to renew it with.
 */
export function buildAuthUrl(clientId: string, redirectUri: string, state?: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
  });
  if (state) params.set("state", state);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
  refresh_token?: string;
}

/** One-time exchange of the consent code for tokens. */
export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${body}`);
  return JSON.parse(body) as TokenResponse;
}

/**
 * Trades the stored refresh token for a fresh access token.
 *
 * The access token is deliberately not cached. It lives for an hour, this runs
 * in a serverless function that may not outlive it, and a cached credential is
 * a credential that can leak. Refreshing costs one round trip and removes the
 * question entirely.
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Refresh failed (${res.status}): ${body}`);
  return JSON.parse(body) as TokenResponse;
}
