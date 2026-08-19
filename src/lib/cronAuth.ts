import { NextRequest, NextResponse } from "next/server";

// Shared bearer-token gate for endpoints triggered by an external scheduler
// (cron-job.org today, the Gmail polling endpoint next). Anything that can
// send a push, spend an API quota, or mutate data on a bare GET needs this -
// those URLs end up in third-party dashboards and logs, so "nobody knows the
// path" is not protection.
//
// Named CRON_SECRET because Vercel's own cron scheduler automatically sends
// `Authorization: Bearer $CRON_SECRET` when an env var of that exact name
// exists, which lets the Vercel cron in vercel.json authenticate against this
// same gate with no extra configuration.
const HEADER = "authorization";
const PREFIX = "Bearer ";

// Constant-time compare so a wrong token can't be recovered by timing the
// response. Length is compared first and leaks only the length.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Returns a 401/500 response to return immediately, or null when the caller is
// authorized. Callers must treat a non-null result as terminal.
export function requireCronSecret(request: NextRequest): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed. An unset secret must never mean "let everyone in" - that
    // would silently unprotect the endpoint the moment the env var goes
    // missing on a redeploy, which is exactly when nobody is looking.
    console.error("CRON_SECRET is not set; refusing to run the scheduled job.");
    return NextResponse.json(
      { status: "ERROR", error: "Server is missing CRON_SECRET" },
      { status: 500 }
    );
  }

  const header = request.headers.get(HEADER);
  if (!header || !header.startsWith(PREFIX) || !safeEqual(header.slice(PREFIX.length), expected)) {
    return NextResponse.json({ status: "ERROR", error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
