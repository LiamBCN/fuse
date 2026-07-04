import { promises as fs } from "fs";
import path from "path";
import { DATA_DIR } from "./db";
import { totalSessionDelta } from "./limit-format";
import { hasRun } from "./run-control";
import { contenderLabel } from "./bench-types";
import { readSharedRun, readSharedRuns } from "./bench-publish";
import type { BenchRun, BenchRunSummary, ContenderResult, JudgePass } from "./bench-types";

export { contenderLabel };

const DIR = path.join(DATA_DIR, "bench");

async function ensure() {
  await fs.mkdir(DIR, { recursive: true });
}

function safeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function fileFor(id: string): string {
  if (!safeId(id)) throw new Error("Invalid benchmark id");
  return path.join(DIR, `${id}.json`);
}

function oneLine(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function labelForResult(result: ContenderResult): string {
  const base = contenderLabel(result.spec);
  return result.rep > 1 ? `${base} · rep ${result.rep}` : base;
}

function modelLabel(model: { provider: string; model: string }): string {
  return `${model.provider}/${model.model}`;
}

function isInFlight(run: BenchRun): boolean {
  return run.status === "running" || run.status === "judging";
}

function markStopped(result: ContenderResult): ContenderResult {
  if (result.status !== "pending" && result.status !== "running") return result;
  return {
    ...result,
    status: "stopped",
    endedAt: result.endedAt ?? Date.now(),
    elapsedMs: result.startedAt ? Date.now() - result.startedAt : result.elapsedMs,
    error: result.error ?? "Server restarted before this contender finished.",
  };
}

// A judge pass that never settled (no scores, no error, not marked done/error)
// on a run whose process is gone → mark stopped, so a restart doesn't leave it
// looking like it's still "judging".
function markJudgePassStopped(pass: JudgePass): JudgePass {
  const settled = pass.status === "done" || pass.status === "error" || pass.status === "stopped";
  if (settled || pass.scores.length || pass.error) return pass;
  return { ...pass, status: "stopped", endedAt: pass.endedAt ?? Date.now(), step: undefined };
}

function surfaceStaleRun(run: BenchRun): BenchRun {
  if (!isInFlight(run) || hasRun(`bench:${run.id}`)) return run;
  return {
    ...run,
    status: "stopped",
    updatedAt: run.updatedAt ?? Date.now(),
    results: run.results.map(markStopped),
    judgePasses: run.judgePasses.map(markJudgePassStopped),
    error: run.error ?? "Server restarted before this benchmark finished.",
  };
}

// Judge-phase call progress for the History card readout while judging: one
// rubric call per pass + one checklist call per checklisted candidate. Falls
// back to a config-derived estimate for runs persisted before the progress
// fields existed. Undefined for execution runs (no judge) and un-judged runs.
export function judgeCallProgress(run: BenchRun): { done: number; total: number } | undefined {
  if (run.config.execute) return undefined;
  if (!run.judgePasses.length && run.status !== "judging") return undefined;
  const doneResultCount = run.results.filter((r) => r.status === "done" && !!r.final?.trim()).length;
  const legacyChecklistPer = run.config.checklist?.length ? doneResultCount : 0;
  const judgeCount = run.config.judges?.length ? run.config.judges.length : run.config.judge ? 1 : 1;
  const expectedPasses = Math.max(run.judgePasses.length, run.config.judgePasses * judgeCount);

  let total = 0;
  let done = 0;
  for (const pass of run.judgePasses) {
    const checklistTotal = pass.checklistTotal ?? legacyChecklistPer;
    total += 1 + checklistTotal;
    if (pass.scores.length > 0 || pass.status === "done") done += 1; // rubric call
    done += pass.checklistDone ?? pass.scores.filter((s) => typeof s.checklistScore === "number").length;
  }
  const missing = expectedPasses - run.judgePasses.length;
  if (missing > 0) total += missing * (1 + legacyChecklistPer);
  return { done, total };
}

function summarize(run: BenchRun): BenchRunSummary {
  const contenders = new Map<string, string>();
  for (const result of run.results) contenders.set(contenderLabel(result.spec), contenderLabel(result.spec));
  const bestRow = run.summary?.[0];
  const bestResult = bestRow ? run.results[bestRow.resultIndex] : undefined;
  const judges = run.config.judges?.length ? run.config.judges : run.config.judge ? [run.config.judge] : [];
  const finished = run.results.filter((result) => result.endedAt);
  const elapsedMs =
    finished.length && run.results.some((result) => result.startedAt)
      ? Math.max(...finished.map((result) => result.endedAt ?? run.updatedAt)) -
        Math.min(...run.results.filter((result) => result.startedAt).map((result) => result.startedAt ?? run.createdAt))
      : undefined;
  const totalTokens = run.results.reduce((sum, result) => sum + (result.usage?.total_tokens ?? 0), 0);
  const totalLimitSessionPct = run.results.reduce((sum, result) => sum + totalSessionDelta(result.limitDelta), 0);
  const verifierResults = run.results.filter((r) => r.verifier);
  const judgeCalls = judgeCallProgress(run);
  return {
    id: run.id,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    status: run.status,
    taskId: run.config.taskId,
    taskTitle: run.config.taskTitle,
    taskSummary: run.config.taskSummary,
    workdir: run.config.workdir,
    promptExcerpt: oneLine(run.config.prompt).slice(0, 140),
    contenderLabels: [...contenders.values()],
    judgeLabels: judges.map(modelLabel),
    resultCount: run.results.length,
    completedCount: run.results.filter((r) => r.status !== "pending" && r.status !== "running").length,
    judgePasses: run.config.judgePasses,
    reps: run.config.reps,
    checklistCount: run.config.checklist?.length ?? 0,
    scoreSource: bestRow?.scoreSource,
    execute: run.config.execute,
    resolvedCount: run.config.execute ? verifierResults.filter((r) => r.verifier?.resolved).length : undefined,
    attemptCount: run.config.execute ? verifierResults.length : undefined,
    elapsedMs,
    totalTokens,
    totalLimitSessionPct,
    best:
      bestRow && bestResult
        ? {
            label: labelForResult(bestResult),
            composite: bestRow.composite,
            spread: bestRow.spread,
            scoreSource: bestRow.scoreSource,
            resolved: bestRow.resolved,
          }
        : undefined,
    judgeCallsDone: judgeCalls?.done,
    judgeCallsTotal: judgeCalls?.total,
    published: !!run.published,
    shared: !!run.shared,
  };
}

async function readRawBenchRun(id: string): Promise<BenchRun | null> {
  if (!safeId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(fileFor(id), "utf8")) as BenchRun;
  } catch {
    return null;
  }
}

export async function listBenchRuns(): Promise<BenchRunSummary[]> {
  await ensure();
  const entries = await fs.readdir(DIR).catch(() => []);
  const runs = await Promise.all(
    entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => readRawBenchRun(path.basename(name, ".json"))),
  );
  const surfaced = runs
    .filter((run): run is BenchRun => !!run)
    .map((run) => ({ original: run, surfaced: surfaceStaleRun(run) }));
  await Promise.all(
    surfaced
      .filter(({ original, surfaced }) => original !== surfaced)
      .map(({ surfaced }) => writeBenchRun(surfaced).catch(() => surfaced)),
  );
  const localSummaries = surfaced.map(({ surfaced }) => summarize(surfaced));
  const localIds = new Set(localSummaries.map((s) => s.id));

  // Merge runs shared via git — deduped by id, local copy wins (it has live
  // status and is writable). Shared-only runs render read-only with a badge.
  const shared = await readSharedRuns().catch(() => []);
  const sharedSummaries = shared
    .filter((run) => !localIds.has(run.id))
    .map((run) => summarize(run));

  return [...localSummaries, ...sharedSummaries].sort((a, b) => b.createdAt - a.createdAt);
}

export async function readBenchRun(id: string): Promise<BenchRun | null> {
  const run = await readRawBenchRun(id);
  if (run) {
    const surfaced = surfaceStaleRun(run);
    if (surfaced !== run) await writeBenchRun(surfaced).catch(() => surfaced);
    return surfaced;
  }
  // Not in the local data dir — fall back to the git results repo (read-only
  // detail view; also the source an extension clones from).
  return readSharedRun(id).catch(() => null);
}

export async function writeBenchRun(run: BenchRun): Promise<BenchRun> {
  await ensure();
  run.updatedAt = Date.now();
  const file = fileFor(run.id);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(run, null, 2), "utf8");
  await fs.rename(tmp, file);
  return run;
}

export async function deleteBenchRun(id: string): Promise<void> {
  if (!safeId(id)) return;
  try {
    await fs.unlink(fileFor(id));
  } catch {
    /* already gone */
  }
}
