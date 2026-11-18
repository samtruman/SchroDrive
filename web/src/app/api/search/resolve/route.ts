import { NextResponse } from "next/server"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978"

export async function POST(request: Request) {
  try {
    const body = await request.text()
    const response = await fetch(`${BACKEND_URL}/api/search/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
    })
    const text = await response.text()

    try {
      return NextResponse.json(JSON.parse(text), { status: response.status })
    } catch {
      return NextResponse.json(
        { ok: false, error: `Backend returned non-JSON response (HTTP ${response.status})` },
        { status: 502 },
      )
    }
  } catch (error: any) {
    console.error("[api/search/resolve] Failed to resolve result:", error?.message || String(error))
    return NextResponse.json(
      { ok: false, error: error?.message || "Backend unavailable" },
      { status: 502 },
    )
  }
}
