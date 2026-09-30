import { NextResponse } from "next/server";

export function backendUnavailable(error: unknown) {
  return NextResponse.json(
    {
      ok: false,
      code: "BACKEND_UNAVAILABLE",
      error: error instanceof Error ? error.message : "Backend unavailable",
    },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

export async function readBackendJson(response: Response) {
  const body = await response.json();
  return NextResponse.json(body, {
    status: response.status,
    headers: { "cache-control": "no-store" },
  });
}
