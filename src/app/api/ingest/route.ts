import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const body = await request.json();
  console.log("Received ingest payload:", body);
  return NextResponse.json({ status: "OK" });
}
