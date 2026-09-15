import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cronAuth";
import { refreshAccessToken } from "@/lib/gmail/auth";

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
    // The scope Google actually granted, not the one that was asked for. A
    // grant that came back narrower - or wider - than gmail.readonly is worth
    // knowing about before it is used to read anything.
    return NextResponse.json({
      status: "OK",
      ok: true,
      checkedAt,
      refreshedInMs: Date.now() - startedAt,
      expiresInSeconds: token.expires_in,
      scope: token.scope,
      // Never the token itself; just enough to tell two grants apart in a log.
      accessTokenFingerprint: token.access_token.slice(-6),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Gmail token health check failed:", message);
    return NextResponse.json(
      { status: "ERROR", ok: false, checkedAt, refreshedInMs: Date.now() - startedAt, error: message },
      { status: 502 }
    );
  }
}
