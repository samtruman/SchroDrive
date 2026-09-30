import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978";

async function forward(request: NextRequest) {
  const response = await fetch(`${BACKEND_URL}/api/version-manager/scan`, {
    method: request.method,
    cache: "no-store",
    headers: request.method === "POST" ? { "content-type": "application/json" } : undefined,
    body: request.method === "POST" ? await request.text() : undefined,
  });
  const body = await response.text();
  return new NextResponse(body, { status: response.status, headers: { "content-type": response.headers.get("content-type") || "application/json" } });
}

export async function GET(request: NextRequest) { return forward(request); }
export async function POST(request: NextRequest) { return forward(request); }
