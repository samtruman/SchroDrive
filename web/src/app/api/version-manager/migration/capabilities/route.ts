import { NextResponse } from "next/server"
import { backendUnavailable, readBackendJson } from "../../_lib/proxy"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8970"

export async function GET() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/version-manager/migration/capabilities`, { cache: "no-store" })
    return readBackendJson(response)
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Migration capabilities unavailable" }, { status: 503 })
  }
}
