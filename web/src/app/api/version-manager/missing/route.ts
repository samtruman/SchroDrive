import { NextResponse } from "next/server"
import { backendUnavailable, readBackendJson } from "../_lib/proxy"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978"

export async function GET() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/version-manager/missing`, { cache: "no-store" })
    return readBackendJson(response)
  } catch (error) {
    return backendUnavailable(error)
  }
}
