import { NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL || "http://schrodrive:8090";

export async function GET() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/version-manager/delete-preview`, { cache: "no-store" });
    const body = await response.json();
    return NextResponse.json(body, { status: response.status });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Backend unavailable" }, { status: 502 });
  }
}
