import { NextResponse } from "next/server";
import { backendUnavailable, readBackendJson } from "../_lib/proxy";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978";
export async function GET(request: Request) { try { const url = new URL(request.url); const response = await fetch(`${BACKEND_URL}/api/version-manager/magnet-backup${url.search}`, { cache: "no-store" }); return readBackendJson(response); } catch (error: any) { return backendUnavailable(error); } }
export async function POST(request: Request) { try { const response = await fetch(`${BACKEND_URL}/api/version-manager/magnet-backup`, { method: "POST", headers: { "content-type": "application/json" }, body: await request.text(), cache: "no-store" }); return readBackendJson(response); } catch (error: any) { return backendUnavailable(error); } }
