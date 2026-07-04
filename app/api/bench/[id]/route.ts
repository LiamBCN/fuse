import { NextRequest, NextResponse } from "next/server";
import { deleteBenchRun, readBenchRun } from "@/lib/bench-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const run = await readBenchRun(params.id);
    if (!run) return NextResponse.json({ error: "Benchmark run not found" }, { status: 404 });
    return NextResponse.json(run);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const run = await readBenchRun(params.id);
    if (!run) return NextResponse.json({ error: "Benchmark run not found" }, { status: 404 });
    if (run.status === "running" || run.status === "judging") {
      return NextResponse.json({ error: "Cannot delete a running benchmark" }, { status: 409 });
    }
    if (run.shared) {
      return NextResponse.json(
        { error: "Shared runs live in git — remove the file from the results repo instead" },
        { status: 409 },
      );
    }
    await deleteBenchRun(params.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
