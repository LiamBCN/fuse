import { NextResponse } from "next/server";
import { detectClis } from "@/lib/cli";

export const runtime = "nodejs";
// Always probe fresh - the user may install a CLI and re-check without restarting.
export const dynamic = "force-dynamic";

// First-run health check: are the local CLIs Fuse depends on installed & runnable?
export async function GET() {
  try {
    const clis = await detectClis();
    return NextResponse.json(clis);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
