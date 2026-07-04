import { NextRequest, NextResponse } from "next/server";
import { fetchAllLimits } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";
  const codexThreadId = req.nextUrl.searchParams.get("codexThreadId") || undefined;
  try {
    return NextResponse.json(await fetchAllLimits({ force, codexThreadId }));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
