import { NextResponse } from "next/server"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978"

export async function POST(request: Request) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/version-manager/import/preview`, {
      method: "POST", headers: { "content-type": "application/json" }, body: await request.text(), cache: "no-store",
    })
    return NextResponse.json(await response.json(), { status: response.status })
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Backend unavailable" }, { status: 502 })
  }
}
