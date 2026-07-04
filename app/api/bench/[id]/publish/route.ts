import { NextRequest, NextResponse } from "next/server";
import { readBenchRun, writeBenchRun } from "@/lib/bench-store";
import { publishBenchRun } from "@/lib/bench-publish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const run = await readBenchRun(params.id);
  if (!run) return NextResponse.json({ error: "Benchmark run not found" }, { status: 404 });
  if (run.status === "running" || run.status === "judging") {
    return NextResponse.json({ error: "Cannot publish a running benchmark" }, { status: 409 });
  }
  if (run.shared) {
    return NextResponse.json({ error: "This run already lives in the results repo" }, { status: 409 });
  }

  try {
    const { state, pushError } = await publishBenchRun(run);
    // publishBenchRun mutates run.published / run.publishError; persist it so the
    // "Published ✓ <sha>" state survives reloads.
    await writeBenchRun(run).catch(() => {});
    return NextResponse.json({ published: state, pushError });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
