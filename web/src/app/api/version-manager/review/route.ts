import { NextResponse } from "next/server"
import { backendUnavailable, readBackendJson } from "../_lib/proxy"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978"

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const status = url.searchParams.get("status")
    const query = status ? `?status=${encodeURIComponent(status)}` : ""
    const response = await fetch(`${BACKEND_URL}/api/version-manager/review${query}`, { cache: "no-store" })
    return readBackendJson(response)
  } catch (error) {
    return backendUnavailable(error)
  }
}
