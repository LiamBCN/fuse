import { NextRequest, NextResponse } from "next/server";
import { checkWorkdir } from "@/lib/bench-snapshots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const workdir = req.nextUrl.searchParams.get("path")?.trim();
  if (!workdir) return NextResponse.json({ error: "path is required" }, { status: 400 });
  try {
    return NextResponse.json(await checkWorkdir(workdir));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
