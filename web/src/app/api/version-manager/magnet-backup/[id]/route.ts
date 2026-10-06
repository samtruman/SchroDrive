import { NextResponse } from "next/server";
import { backendUnavailable, readBackendJson } from "../../_lib/proxy";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8978";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { try { const { id } = await context.params; const response = await fetch(`${BACKEND_URL}/api/version-manager/magnet-backup/${encodeURIComponent(id)}`, { cache: "no-store" }); return readBackendJson(response); } catch (error: any) { return backendUnavailable(error); } }
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) { try { const { id } = await context.params; const response = await fetch(`${BACKEND_URL}/api/version-manager/magnet-backup/${encodeURIComponent(id)}`, { method: "DELETE", cache: "no-store" }); return readBackendJson(response); } catch (error: any) { return backendUnavailable(error); } }
