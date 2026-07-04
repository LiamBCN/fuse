import { NextRequest, NextResponse } from "next/server";
import { stopRuns } from "@/lib/run-control";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { conversationId } = await req.json().catch(() => ({}));
  if (!conversationId) return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  return NextResponse.json({ stopped: stopRuns(conversationId) });
}
