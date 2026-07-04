import { NextRequest, NextResponse } from "next/server";
import { readSettings, redactSettings, writeSettings } from "@/lib/settings-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/settings - current config (keys + models). Local app only.
export async function GET() {
  try {
    return NextResponse.json(redactSettings(await readSettings()));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

// POST /api/settings - save config.
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    return NextResponse.json(redactSettings(await writeSettings(body)));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
