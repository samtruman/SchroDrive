import { NextResponse } from "next/server"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8970"

export async function GET() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/version-manager/migration/capabilities`, { cache: "no-store" })
    return new NextResponse(await response.text(), { status: response.status, headers: { "content-type": "application/json" } })
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Migration capabilities unavailable" }, { status: 503 })
  }
}
