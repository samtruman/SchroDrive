import { NextResponse } from "next/server";
import { backendUnavailable } from "../../../_lib/proxy";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const response = await fetch(`${BACKEND_URL}/api/version-manager/magnet-backup/${encodeURIComponent(id)}/download`, { cache: "no-store" });
    const headers = new Headers();
    for (const name of ["content-type", "content-disposition", "content-length", "cache-control"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new NextResponse(response.body, { status: response.status, headers });
  } catch (error: any) {
    return backendUnavailable(error);
  }
}
