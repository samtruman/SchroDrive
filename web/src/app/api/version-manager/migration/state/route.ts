import { NextRequest, NextResponse } from "next/server"
import { backendUnavailable, readBackendJson } from "../../_lib/proxy"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8970"

export async function GET(request: NextRequest) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/version-manager/migration/state${request.nextUrl.search}`, { cache: "no-store" })
    return readBackendJson(response)
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Migration state unavailable" }, { status: 503 })
  }
}
