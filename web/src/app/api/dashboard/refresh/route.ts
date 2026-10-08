import { NextResponse } from "next/server"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978"

export async function POST() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/dashboard/refresh`, {
      method: "POST",
      cache: "no-store",
    })
    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Dashboard refresh failed"
    console.error("[api/dashboard/refresh] Failed to reach backend:", message)
    return NextResponse.json({ ok: false, error: message }, { status: 503 })
  }
}
