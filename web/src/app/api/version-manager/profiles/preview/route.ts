import { NextRequest } from "next/server";
import { backendUnavailable, readBackendJson } from "../../_lib/proxy";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978";

export async function POST(request: NextRequest) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/version-manager/profiles/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await request.text(),
    });
    return readBackendJson(response);
  } catch (error) {
    return backendUnavailable(error);
  }
}
