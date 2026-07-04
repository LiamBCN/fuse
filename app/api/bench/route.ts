import { NextRequest, NextResponse } from "next/server";
import { startBenchRun } from "@/lib/bench";
import { listBenchRuns } from "@/lib/bench-store";
import { readBenchTask } from "@/lib/bench-task-store";
import type { BenchConfig, ContenderSpec } from "@/lib/bench-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isModelRef(value: any): boolean {
  return (
    value &&
    (value.provider === "claude-cli" || value.provider === "codex-cli") &&
    typeof value.model === "string" &&
    value.model.trim().length > 0
  );
}

function isContender(value: any): value is ContenderSpec {
  if (!value || typeof value !== "object") return false;
  if (value.kind === "solo") return isModelRef(value.model);
  if (value.kind !== "mode") return false;
  return (
    (value.mode === "fast" || value.mode === "relay" || value.mode === "recon") &&
    Array.isArray(value.proposers) &&
    value.proposers.length > 0 &&
    value.proposers.every(isModelRef) &&
    isModelRef(value.aggregator)
  );
}

async function validateConfig(body: any): Promise<{ config?: BenchConfig; error?: string }> {
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  const taskId = typeof body?.taskId === "string" && body.taskId.trim() ? body.taskId.trim() : undefined;
  const task = taskId ? await readBenchTask(taskId) : null;
  if (taskId && !task) return { error: "Benchmark task not found" };
  if (!prompt && !task) return { error: "Prompt required" };

  const contenders = Array.isArray(body?.contenders) ? body.contenders.filter(isContender) : [];
  if (contenders.length < 2) return { error: "Select at least two contenders" };

  const judges = Array.isArray(body?.judges) ? body.judges.filter(isModelRef).slice(0, 2) : [];
  const judge = judges[0] ?? (isModelRef(body?.judge) ? body.judge : { provider: "claude-cli", model: "claude-opus-4-8" });
  const judgePasses = Number(body?.judgePasses ?? 3);
  const reps = Number(body?.reps ?? 1);

  // Execution mode: only honored when the selected task actually has a verifier.
  // normalizeConfig re-checks this too, so a stale client can't force it on.
  const execute = !!body?.execute && !!task?.verifier?.steps?.length;
  const executor = isModelRef(body?.executor) ? body.executor : undefined;

  return {
    config: {
      prompt: task?.prompt ?? prompt,
      workdir: typeof body?.workdir === "string" && body.workdir.trim() ? body.workdir.trim() : undefined,
      contenders,
      judge,
      judges: judges.length ? judges : undefined,
      judgePasses,
      reps,
      taskId,
      checklist: task?.checklist ?? (Array.isArray(body?.checklist) ? body.checklist : undefined),
      execute,
      executor,
    },
  };
}

export async function GET() {
  try {
    return NextResponse.json(await listBenchRuns());
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { config, error } = await validateConfig(body);
  if (error || !config) return NextResponse.json({ error }, { status: 400 });

  try {
    const id = await startBenchRun(config);
    return NextResponse.json({ id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
