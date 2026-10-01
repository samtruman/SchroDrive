import { backendUnavailable, readBackendJson } from "../../_lib/proxy";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978";
export async function POST(request: Request) {
  try {
    return readBackendJson(await fetch(`${BACKEND_URL}/api/version-manager/migration/preview`, {
      method: "POST", headers: { "content-type": "application/json" }, body: await request.text(), cache: "no-store",
    }));
  } catch (error: any) { return backendUnavailable(error); }
}
