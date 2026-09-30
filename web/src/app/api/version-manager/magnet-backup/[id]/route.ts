import { NextResponse } from "next/server";
const BACKEND_URL = process.env.BACKEND_URL || "http://schrodrive:8090";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { try { const { id } = await context.params; const response = await fetch(`${BACKEND_URL}/api/version-manager/magnet-backup/${encodeURIComponent(id)}`, { cache: "no-store" }); return NextResponse.json(await response.json(), { status: response.status }); } catch (error: any) { return NextResponse.json({ ok: false, error: error?.message || "Backend unavailable" }, { status: 502 }); } }
