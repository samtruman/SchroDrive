import { NextRequest } from "next/server"
import { backendUnavailable, readBackendJson } from "../../../version-manager/_lib/proxy"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978"

/** Generic TMDB resolver proxy shared by intake and Media Manager callers. */
export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams.toString()
    const response = await fetch(`${BACKEND_URL}/api/metadata/tmdb/resolve${query ? `?${query}` : ""}`, { cache: "no-store" })
    return readBackendJson(response)
  } catch (error) {
    return backendUnavailable(error)
  }
}
