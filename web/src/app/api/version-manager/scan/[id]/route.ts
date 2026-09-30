import { NextRequest, NextResponse } from "next/server";
import { backendUnavailable } from "../../_lib/proxy";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const response = await fetch(`${BACKEND_URL}/api/version-manager/scan/${encodeURIComponent(id)}`, { cache: "no-store" });
    const body = await response.text();
    return new NextResponse(body, { status: response.status, headers: { "content-type": response.headers.get("content-type") || "application/json", "cache-control": "no-store" } });
  } catch (error) {
    return backendUnavailable(error);
  }
}
