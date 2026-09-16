import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cronAuth";
import { refreshAccessToken } from "@/lib/gmail/auth";
import { checkPollerHealth } from "@/lib/gmail/pollerHealth";

/**
 * Token health: can we still get an access token?
 *
 * A refresh token is a credential that expires without telling anyone. Google
 * revokes it if the password changes, if consent is withdrawn, if it goes
 * six months unused, or if the app stays in "Testing" on the OAuth consent
 * screen - where refresh tokens last seven days. Every one of those looks
 * identical from here until something tries to read mail and cannot.
 *
 * So this attempts a real refresh rather than checking a stored expiry. It
 * reports what happened and when, and nothing else: no mail is read, nothing
 * is written, and the access token it obtains is discarded unused. Protected
 * because an unauthenticated endpoint that exercises a credential on demand is
 * a way to burn quota, and because its error text names why a grant failed.
 *
 * It also answers a second question the token cannot: is the poller actually
 * working? Two of its failure modes are invisible from the outside. A run that
 * falls back to a date-range query returns HTTP 200 and looks healthy, so a
 * cursor that is never being saved would degrade the sync to a rescan every
 * fifteen minutes and page nobody. And a scheduler that stops calling produces
 * no failed runs at all - just silence, which looks exactly like a quiet
 * mailbox. Both are checked here because this is the endpoint a scheduler
 * already watches.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  const checkedAt = new Date().toISOString();
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  const missing = [
    !clientId && "GOOGLE_CLIENT_ID",
    !clientSecret && "GOOGLE_CLIENT_SECRET",
    !refreshToken && "GOOGLE_REFRESH_TOKEN",
  ].filter(Boolean);
  if (missing.length > 0) {
    return NextResponse.json(
      { status: "ERROR", ok: false, checkedAt, reason: "not configured", missing },
      { status: 503 }
    );
  }

  const startedAt = Date.now();
  try {
    const token = await refreshAccessToken(refreshToken!, clientId!, clientSecret!);
    const poller = await checkPollerHealth();
    // The scope Google actually granted, not the one that was asked for. A
    // grant that came back narrower - or wider - than gmail.readonly is worth
    // knowing about before it is used to read anything.
    const body = {
      status: poller.ok ? "OK" : "ERROR",
      ok: poller.ok,
      checkedAt,
      refreshedInMs: Date.now() - startedAt,
      expiresInSeconds: token.expires_in,
      scope: token.scope,
      // Never the token itself; just enough to tell two grants apart in a log.
      accessTokenFingerprint: token.access_token.slice(-6),
      token: { ok: true },
      poller,
    };
    if (!poller.ok) {
      console.error(`Gmail poller unhealthy: ${poller.problems.map((p) => p.condition).join("; ")}`);
    }
    // 503 rather than 502: the credential is fine, the thing that uses it is
    // not, and a scheduler's alert text should not send anyone looking at OAuth.
    return NextResponse.json(body, { status: poller.ok ? 200 : 503 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Gmail token health check failed:", message);
    return NextResponse.json(
      { status: "ERROR", ok: false, checkedAt, refreshedInMs: Date.now() - startedAt, error: message, token: { ok: false } },
      { status: 502 }
    );
  }
}
