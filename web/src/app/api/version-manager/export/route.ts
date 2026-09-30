import { NextResponse } from "next/server"
import { backendUnavailable } from "../_lib/proxy"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978"

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const response = await fetch(`${BACKEND_URL}/api/version-manager/export${url.search}`, { cache: "no-store" })
    const body = await response.arrayBuffer()
    const headers = new Headers()
    const contentType = response.headers.get("content-type")
    const disposition = response.headers.get("content-disposition")
    if (contentType) headers.set("content-type", contentType)
    if (disposition) headers.set("content-disposition", disposition)
    return new NextResponse(body, { status: response.status, headers })
  } catch (error) {
    return backendUnavailable(error)
  }
}
