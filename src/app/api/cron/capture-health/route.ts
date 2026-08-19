import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cronAuth";
import { runCaptureHealthChecks } from "@/lib/captureHealth";

// Scheduled capture-health check, triggered externally by cron-job.org every
// ~30 minutes. Replaces the GitHub Actions workflow that used to drive this -
// same checks, same alerting, no Actions minutes.
//
// Protected because it is not a read-only endpoint: it can fan out a Web Push
// to every subscribed device and write alert timestamps. An unauthenticated
// URL sitting in a third-party scheduler's dashboard is a push-spam button for
// anyone who sees it.
//
// GET and POST both work so the scheduler can use either; cron-job.org
// defaults to GET, and Vercel's own cron only issues GET.
export const maxDuration = 60;

async function handle(request: NextRequest): Promise<NextResponse> {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  const result = await runCaptureHealthChecks();
  return NextResponse.json(result, { status: result.status === "ERROR" ? 500 : 200 });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
