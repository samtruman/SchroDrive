import { promises as fs } from "node:fs"

import { NextResponse } from "next/server"

const BUILD_INFO_FILE = process.env.SCHRODRIVE_BUILD_INFO_FILE || "/app/BUILD_INFO.json"

export async function GET() {
  try {
    const content = await fs.readFile(BUILD_INFO_FILE, "utf8")
    return NextResponse.json(JSON.parse(content), { headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json(
      {
        version: process.env.SCHRODRIVE_VERSION || "0.11.5",
        commit: process.env.SCHRODRIVE_BUILD_COMMIT || "unknown",
      },
      { headers: { "Cache-Control": "no-store" } },
    )
  }
}
