import { NextRequest, NextResponse } from "next/server";
import { readBenchTask } from "@/lib/bench-task-store";
import { ensureSnapshot, getSnapshotStatus } from "@/lib/bench-snapshots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const task = await readBenchTask(params.id);
    if (!task) return NextResponse.json({ error: "Benchmark task not found" }, { status: 404 });
    return NextResponse.json(await getSnapshotStatus(task));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const task = await readBenchTask(params.id);
    if (!task) return NextResponse.json({ error: "Benchmark task not found" }, { status: 404 });
    if (!task.repos.length) return NextResponse.json({ ready: true, path: undefined, repos: [] });
    return NextResponse.json(await ensureSnapshot(task));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
