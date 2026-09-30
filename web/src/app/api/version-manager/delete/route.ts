import { NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL || "http://schrodrive:8090";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const response = await fetch(`${BACKEND_URL}/api/version-manager/delete${url.search}`, { cache: "no-store" });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Backend unavailable" }, { status: 502 });
  }
}
