import { NextRequest, NextResponse } from "next/server";
import { stopBenchRun } from "@/lib/bench";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  return NextResponse.json({ stopped: stopBenchRun(params.id) });
}
