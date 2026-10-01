import { backendUnavailable, readBackendJson } from "../_lib/proxy";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978";

export async function GET() {
  try { return readBackendJson(await fetch(`${BACKEND_URL}/api/version-manager/providers`, { cache: "no-store" })); }
  catch (error) { return backendUnavailable(error); }
}
