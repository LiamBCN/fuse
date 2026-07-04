import { NextRequest, NextResponse } from "next/server";
import { extendBenchRun } from "@/lib/bench";
import { readBenchRun } from "@/lib/bench-store";
import type { ContenderSpec } from "@/lib/bench-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RESULTS = 12;

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

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const run = await readBenchRun(params.id);
  if (!run) return NextResponse.json({ error: "Benchmark run not found" }, { status: 404 });
  if (run.status === "running" || run.status === "judging") {
    return NextResponse.json({ error: "Cannot extend a running benchmark" }, { status: 409 });
  }

  const contenders = Array.isArray(body?.contenders) ? body.contenders.filter(isContender) : [];
  if (!contenders.length) return NextResponse.json({ error: "Select at least one contender to add" }, { status: 400 });

  const projected = run.results.length + contenders.length * Math.max(1, run.config.reps);
  if (projected > MAX_RESULTS) {
    return NextResponse.json(
      { error: `Too many results (${projected} > ${MAX_RESULTS}). Remove some contenders.` },
      { status: 400 },
    );
  }

  try {
    const id = await extendBenchRun(params.id, contenders);
    return NextResponse.json({ id }, { status: 202 });
  } catch (e: any) {
    const message = e?.message ?? String(e);
    const status = /running/i.test(message) ? 409 : /not found/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
