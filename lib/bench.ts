import { randomUUID } from "crypto";
import { appendUsage, type UsageItem } from "./db";
import { diffLimitSnapshots, fetchAllLimits } from "./limits";
import { estimateCost } from "./models";
import { runMoa } from "./moa";
import { QA_NOTE, REQUIREMENT_COVERAGE_NOTE, runPlan } from "./plan";
import { callModel, type ChatMessage } from "./providers";
import { AgentFailedError, RunStoppedError, classifyCliError, registerRun, stopRuns } from "./run-control";
import { readBenchRun, writeBenchRun } from "./bench-store";
import { readBenchTask } from "./bench-task-store";
import { resetSnapshot, snapshotWorkdir } from "./bench-snapshots";
import { autoPublishBenchRun } from "./bench-publish";
import { runVerifier } from "./bench-verifier";
import {
  BENCH_CRITERIA,
  type BenchConfig,
  type BenchCriterion,
  type BenchRun,
  type BenchSummaryRow,
  type BenchUsageItem,
  type ContenderResult,
  type ContenderSpec,
  type ContenderStatus,
  type JudgePass,
  type JudgeScore,
  type VerifierResult,
} from "./bench-types";
import type { BenchTask, ChecklistItem } from "./bench-tasks";
import { promises as fs } from "fs";
import type { LimitSnapshot, ModelRef, Usage, UsageLimitDeltas } from "./types";

const DEFAULT_JUDGE: ModelRef = { provider: "claude-cli", model: "claude-opus-4-8" };
const DEFAULT_SECOND_JUDGE: ModelRef = { provider: "codex-cli", model: "default" };
// Mid-tier default executor: strong enough to implement, weak enough that the
// quality of the upstream plan still moves the outcome (the variable we test).
const DEFAULT_EXECUTOR: ModelRef = { provider: "claude-cli", model: "claude-sonnet-5" };

const EXEC_SYS = `You are a senior software engineer implementing a change in the working directory for a benchmark. Make ALL necessary code edits to fully and correctly implement the task. You may read, create, edit, and delete files and run commands inside the working directory.

Rules:
- Implement real, working code. Your output is graded by automated checks over the actual git diff (and any configured tests), so narration alone scores zero — the code must change.
- Do not ask clarifying questions; make reasonable assumptions.
- Do not revert, stub, or disable existing functionality to make checks pass.
- Keep the change scoped to the task. When finished, end with a short "Changed files:" list.`;

const NO_CLARIFY_NOTE =
  "\n\nBenchmark instruction: Do not ask clarifying questions; make reasonable assumptions and state them.";

const SOLO_PLAN_SYS = `You are a senior software engineer creating an IMPLEMENTATION PLAN for a benchmark. You have the same task contract as Fuse plan modes, but you are working alone in a single pass.

If a project is available in the working directory, inspect the relevant files first and reference real paths. Do not create or modify files. Produce a thorough, concrete, step-by-step plan in GitHub-flavored Markdown with sections, exactly in this order:
## Goal
## Affected files
## Implementation steps
## Risks & mitigations
## Testing

Output only the Markdown plan. Do not ask clarifying questions; make reasonable assumptions and state them in the plan.${QA_NOTE}${REQUIREMENT_COVERAGE_NOTE}`;

const SOLO_CHAT_SYS =
  "Answer the user's request directly and completely. Do not ask clarifying questions; make reasonable assumptions and state them briefly.";

const JUDGE_SYS = `You are a blind benchmark judge. Score candidate outputs against the same original request, using only quality and correctness. Do not reward or penalize speed, token count, provider, or model identity; those are hidden on purpose. Longer is not better; reward the shortest plan that fully covers the request.

Return JSON only: an array with one object per candidate:
[
  {
    "candidate": "A",
    "scores": {
      "groundedness": 0,
      "requirementCoverage": 0,
      "actionability": 0,
      "testingQuality": 0,
      "clarityScope": 0
    },
    "rationale": "short reason"
  }
]

Use integers or decimals from 0 to 10. Scores mean:
- groundedness: cited paths, symbols, signatures, and current behavior are real and plausible.
- requirementCoverage: every requirement is covered or explicitly descoped.
- actionability: steps are concrete enough to execute without re-deriving the design.
- testingQuality: testing steps are satisfiable by the plan and current code.
- clarityScope: structure is clear, proportional, and does not invent scope.

When you have working-directory access, verify a representative sample of cited paths and symbols before scoring groundedness.`;

const CHECKLIST_JUDGE_SYS = `You are a narrow benchmark checklist verifier. Verify each checklist item against one candidate implementation plan and, when a working directory is available, against the real code in that directory.

Return JSON only:
[
  { "itemId": "id", "verdict": "yes" },
  { "itemId": "id", "verdict": "no" },
  { "itemId": "id", "verdict": "unknown" }
]

Use "yes" only when the candidate clearly satisfies the item. Use "no" when it clearly does not. Use "unknown" when the candidate is ambiguous or the code cannot be verified. For negative-point items, "yes" means the candidate committed that failure.`;

const clamp = (n: number, min: number, max: number, fallback: number) =>
  Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;

const sumUsage = (items: BenchUsageItem[]): Usage =>
  items.reduce(
    (a, it) => ({
      prompt_tokens: a.prompt_tokens + (it.prompt_tokens || 0),
      completion_tokens: a.completion_tokens + (it.completion_tokens || 0),
      total_tokens: a.total_tokens + (it.total_tokens || 0),
    }),
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  );

const asBenchUsageItems = (items: UsageItem[]): BenchUsageItem[] => items.map((item) => ({ ...item }));

function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a && !b) return undefined;
  return {
    prompt_tokens: (a?.prompt_tokens ?? 0) + (b?.prompt_tokens ?? 0),
    completion_tokens: (a?.completion_tokens ?? 0) + (b?.completion_tokens ?? 0),
    total_tokens: (a?.total_tokens ?? 0) + (b?.total_tokens ?? 0),
  };
}

function isModelRef(input: any): input is ModelRef {
  return (
    input &&
    (input.provider === "claude-cli" || input.provider === "codex-cli") &&
    typeof input.model === "string" &&
    input.model.trim().length > 0
  );
}

function normalizeJudges(input: BenchConfig, builtInTask: boolean): ModelRef[] {
  const raw = Array.isArray(input.judges) && input.judges.length ? input.judges : input.judge ? [input.judge] : [];
  const judges = raw.filter(isModelRef).slice(0, 2).map((judge) => ({ provider: judge.provider, model: judge.model.trim() }));
  if (judges.length) return judges;
  return builtInTask ? [DEFAULT_JUDGE, DEFAULT_SECOND_JUDGE] : [DEFAULT_JUDGE];
}

async function normalizeConfig(input: BenchConfig): Promise<BenchConfig> {
  const task = input.taskId ? await readBenchTask(input.taskId) : null;
  if (input.taskId && !task) throw new Error("Benchmark task not found");
  const workdir = task?.repos.length ? await snapshotWorkdir(task) : input.workdir?.trim() || undefined;
  const judges = normalizeJudges(input, !!task?.builtIn);
  // Execution mode requires a task with a verifier and a working directory to
  // change; without both, fall back to the plan-judging benchmark.
  const execute = !!input.execute && !!task?.verifier?.steps.length && !!workdir;
  const executor = isModelRef(input.executor) ? input.executor : DEFAULT_EXECUTOR;
  return {
    prompt: (task?.prompt ?? input.prompt ?? "").trim(),
    workdir,
    contenders: Array.isArray(input.contenders) ? input.contenders : [],
    judge: judges[0],
    judges,
    judgePasses: clamp(Number(input.judgePasses), 1, 5, 3),
    reps: clamp(Number(input.reps), 1, 3, 1),
    taskId: task?.id ?? input.taskId,
    taskTitle: task?.title ?? input.taskTitle,
    taskSummary: task?.summary ?? input.taskSummary,
    checklist: task?.checklist?.length ? task.checklist : Array.isArray(input.checklist) ? input.checklist : undefined,
    execute,
    executor: execute ? executor : undefined,
  };
}

function buildResults(config: BenchConfig): ContenderResult[] {
  const results: ContenderResult[] = [];
  for (let rep = 1; rep <= config.reps; rep++) {
    for (const spec of config.contenders) {
      results.push({ spec, rep, status: "pending" });
    }
  }
  return results;
}

export async function startBenchRun(input: BenchConfig): Promise<string> {
  const config = await normalizeConfig(input);
  const id = randomUUID();
  const now = Date.now();
  const run: BenchRun = {
    id,
    createdAt: now,
    updatedAt: now,
    status: "running",
    config,
    results: buildResults(config),
    judgePasses: [],
  };

  const ac = new AbortController();
  const unregister = registerRun(`bench:${id}`, ac);
  try {
    await writeBenchRun(run);
  } catch (e) {
    unregister();
    throw e;
  }

  void runBenchJob(run, ac).finally(unregister);
  return id;
}

export function stopBenchRun(id: string): boolean {
  return stopRuns(`bench:${id}`);
}

async function persist(run: BenchRun) {
  await writeBenchRun(run);
}

async function appendUsageSafe(runId: string, items: BenchUsageItem[] | undefined, limits?: UsageLimitDeltas) {
  if (!items?.length) return;
  await appendUsage({ ts: Date.now(), conversationId: `bench:${runId}`, items: items as UsageItem[], limits }).catch(() => {});
}

const latestCodexThreadId = (items: BenchUsageItem[]): string | undefined =>
  [...items].reverse().find((item) => item.provider === "codex-cli" && item.sessionId)?.sessionId;

async function captureBenchLimitDelta(
  before: LimitSnapshot | null,
  items: BenchUsageItem[] | undefined,
): Promise<UsageLimitDeltas | undefined> {
  if (!items?.length) return undefined;
  const after = await fetchAllLimits({ force: true, codexThreadId: latestCodexThreadId(items) }).catch(() => null);
  return diffLimitSnapshots(before, after);
}

function hasClarifyMarker(text: string | undefined): boolean {
  return !!text && text.includes("@@CLARIFY@@");
}

function stoppedMessage(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /^Run stopped\.?$/i.test(msg.trim());
}

function finishResult(
  result: ContenderResult,
  status: ContenderStatus,
  patch: Partial<ContenderResult> = {},
) {
  const endedAt = Date.now();
  Object.assign(result, {
    ...patch,
    status,
    endedAt,
    elapsedMs: result.startedAt ? endedAt - result.startedAt : patch.elapsedMs,
  });
}

function markRestStopped(run: BenchRun, fromIndex = 0) {
  const now = Date.now();
  for (let i = fromIndex; i < run.results.length; i++) {
    const result = run.results[i];
    if (result.status !== "pending" && result.status !== "running") continue;
    result.status = "stopped";
    result.endedAt = now;
    result.elapsedMs = result.startedAt ? now - result.startedAt : result.elapsedMs;
    result.error = result.error ?? "Benchmark stopped.";
  }
}

// Mark any judge pass still pending/running (or with no recorded status yet) as
// stopped — mirrors markRestStopped for the judging phase so a stopped run never
// leaves a pass looking live.
function markRestJudgePassesStopped(run: BenchRun) {
  const now = Date.now();
  for (const pass of run.judgePasses) {
    const settled = pass.status === "done" || pass.status === "error" || pass.status === "stopped";
    const hasResult = !!pass.scores.length || !!pass.error;
    if (settled || hasResult) continue;
    pass.status = "stopped";
    pass.endedAt = pass.endedAt ?? now;
    delete pass.step;
  }
}

// Run one contender (result index `i`). Returns "stopped" when the run was
// aborted mid-contender (the caller halts the whole run), "ok" otherwise —
// including recorded error / rate-limit outcomes, which do not stop the run.
async function runOneContender(
  run: BenchRun,
  i: number,
  task: BenchTask | undefined,
  ac: AbortController,
): Promise<"ok" | "stopped"> {
  const result = run.results[i];
  result.status = "running";
  result.startedAt = Date.now();
  delete result.endedAt;
  delete result.error;
  delete result.limitDelta;
  await persist(run);

  let limitBefore: LimitSnapshot | null = null;
  try {
    if (task?.repos.length) await resetSnapshot(task);
    limitBefore = await fetchAllLimits().catch(() => null);
    const output = await runContender(run.config, result, task, ac.signal);
    const limitDelta = await captureBenchLimitDelta(limitBefore, output.usageItems);
    const status = output.clarified || hasClarifyMarker(output.final) ? "clarified" : "done";
    finishResult(result, status, {
      final: output.final,
      usageItems: output.usageItems,
      usage: sumUsage(output.usageItems),
      limitDelta,
      verifier: output.verifier,
      error: status === "clarified" ? "Returned a clarifying-question marker." : undefined,
    });
    await appendUsageSafe(run.id, output.usageItems, limitDelta);
    await persist(run);
    return "ok";
  } catch (e: any) {
    const items =
      e instanceof AgentFailedError || e instanceof RunStoppedError ? asBenchUsageItems(e.usageItems) : [];
    const limitDelta = await captureBenchLimitDelta(limitBefore, items);
    if (ac.signal.aborted || e instanceof RunStoppedError || stoppedMessage(e)) {
      finishResult(result, "stopped", { usageItems: items, usage: sumUsage(items), limitDelta, error: "Benchmark stopped." });
      await appendUsageSafe(run.id, items, limitDelta);
      return "stopped";
    }
    const info = e instanceof AgentFailedError ? e.info : classifyCliError(e?.message ?? String(e));
    const status = info.kind === "rate-limit" ? "rateLimited" : "error";
    finishResult(result, status, {
      usageItems: items,
      usage: sumUsage(items),
      limitDelta,
      error: e?.message ?? String(e),
    });
    await appendUsageSafe(run.id, items, limitDelta);
    await persist(run);
    return "ok";
  }
}

// Drive a contiguous list of result indices through the contender phase. Both
// the fresh run (all indices) and an extension (only the new indices) use this.
// Returns false when the run was stopped, true when the phase completed.
async function runContenderPhase(
  run: BenchRun,
  indices: number[],
  task: BenchTask | undefined,
  ac: AbortController,
): Promise<boolean> {
  for (const i of indices) {
    if (ac.signal.aborted) {
      markRestStopped(run, i);
      run.status = "stopped";
      await persist(run);
      return false;
    }
    const outcome = await runOneContender(run, i, task, ac);
    if (outcome === "stopped") {
      markRestStopped(run, i + 1);
      run.status = "stopped";
      await persist(run);
      return false;
    }
  }
  return true;
}

// Judge (or verify) the finished contenders, then mark the run done. On an
// extension, `judgeOnlyIndices` restricts the expensive per-candidate checklist
// calls to the new candidates; the rubric still scores everyone side-by-side.
async function finalizeBenchRun(
  run: BenchRun,
  task: BenchTask | undefined,
  ac: AbortController,
  judgeOnlyIndices?: number[],
) {
  if (ac.signal.aborted) {
    markRestStopped(run);
    run.status = "stopped";
    await persist(run);
    return;
  }

  if (run.config.execute) {
    // Deterministic verification replaced the LLM judge, so there is nothing
    // left to score — just summarize the pass@1 verdicts.
    run.summary = summarizeExecution(run);
    if (!run.summary.length) run.error = run.error ?? "No contenders produced a verifiable result.";
    run.status = "done";
    await persist(run);
  } else {
    await judgeRun(run, ac.signal, task, judgeOnlyIndices);
    if (run.status !== "stopped") {
      run.summary = summarize(run);
      if (!run.summary.length) run.error = run.error ?? "No successful contenders were available to judge.";
      run.status = "done";
      await persist(run);
    }
  }

  if (run.status === "done") {
    await autoPublishBenchRun(run); // best-effort; mutates run.published / run.publishError
    await persist(run);
  }
}

async function runBenchJob(run: BenchRun, ac: AbortController) {
  try {
    const task = run.config.taskId ? await readBenchTask(run.config.taskId) : null;
    const allIndices = run.results.map((_, index) => index);
    const completed = await runContenderPhase(run, allIndices, task ?? undefined, ac);
    if (!completed) return;
    await finalizeBenchRun(run, task ?? undefined, ac);
  } catch (e: any) {
    await recordJobFailure(run, ac, e);
  }
}

async function recordJobFailure(run: BenchRun, ac: AbortController, e: any) {
  if (ac.signal.aborted || e instanceof RunStoppedError || stoppedMessage(e)) {
    markRestStopped(run);
    markRestJudgePassesStopped(run);
    run.status = "stopped";
    run.error = "Benchmark stopped.";
  } else {
    run.status = "error";
    run.error = e?.message ?? String(e);
  }
  await persist(run).catch(() => {});
}

// Extend a finished run with new contenders: reuse every existing output and
// judge verdict, run only the new specs, and judge them side-by-side with the
// incumbents (checklist only for the new candidates — the token saver).
export async function extendBenchRun(id: string, contenders: ContenderSpec[]): Promise<string> {
  const source = await readBenchRun(id);
  if (!source) throw new Error("Benchmark run not found");
  if (source.status === "running" || source.status === "judging") {
    throw new Error("Cannot extend a running benchmark");
  }
  const specs = contenders.filter(isContenderSpec);
  if (!specs.length) throw new Error("No valid contenders to add");

  // Shared (git) runs are read-only; clone into the local data dir first so the
  // extension has a mutable, live-status copy that references the original. The
  // clone is local, so it must NOT carry the transient `shared` marker.
  const run: BenchRun = source.shared
    ? {
        ...source,
        id: randomUUID(),
        createdAt: Date.now(),
        extendedFrom: id,
        shared: undefined,
        published: undefined,
        publishError: undefined,
      }
    : source;
  // A prior publish of this run is now stale (new contenders change the result);
  // clear it so the button re-publishes and no old export lingers as "current".
  run.published = undefined;
  run.publishError = undefined;

  const task = run.config.taskId ? await readBenchTask(run.config.taskId) : null;
  if (task?.repos.length) {
    const workdir = await snapshotWorkdir(task);
    if (workdir) run.config.workdir = workdir;
  } else if (run.config.workdir && !(await pathExists(run.config.workdir))) {
    throw new Error(`Working folder no longer exists: ${run.config.workdir}. Cannot extend this run.`);
  }

  const startIndex = run.results.length;
  run.config.contenders = [...run.config.contenders, ...specs];
  for (const spec of specs) {
    for (let rep = 1; rep <= run.config.reps; rep++) {
      run.results.push({ spec, rep, status: "pending", extension: true });
    }
  }
  const newIndices: number[] = [];
  for (let i = startIndex; i < run.results.length; i++) newIndices.push(i);

  run.summary = undefined;
  run.error = undefined;
  run.status = "running";

  const ac = new AbortController();
  const unregister = registerRun(`bench:${run.id}`, ac);
  try {
    await writeBenchRun(run);
  } catch (e) {
    unregister();
    throw e;
  }

  void runExtendJob(run, task ?? undefined, newIndices, ac).finally(unregister);
  return run.id;
}

async function runExtendJob(run: BenchRun, task: BenchTask | undefined, newIndices: number[], ac: AbortController) {
  try {
    const completed = await runContenderPhase(run, newIndices, task, ac);
    if (!completed) return;
    await finalizeBenchRun(run, task, ac, newIndices);
  } catch (e: any) {
    await recordJobFailure(run, ac, e);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isContenderSpec(value: any): value is ContenderSpec {
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

interface ContenderOutput {
  final: string;
  usageItems: BenchUsageItem[];
  clarified?: boolean;
  verifier?: VerifierResult;
}

async function runContender(
  config: BenchConfig,
  result: ContenderResult,
  task: BenchTask | undefined,
  signal: AbortSignal,
): Promise<ContenderOutput> {
  if (config.execute) return runExecutionContender(config, result, task, signal);

  const messages: ChatMessage[] = [{ role: "user", content: `${config.prompt}${NO_CLARIFY_NOTE}` }];
  const spec = result.spec;

  if (spec.kind === "mode") {
    if (config.workdir) {
      const plan = await runPlan(
        messages,
        spec.proposers,
        spec.aggregator,
        spec.mode,
        config.workdir,
        undefined,
        undefined,
        spec.stageModels,
        signal,
      );
      return {
        final: plan.final,
        usageItems: asBenchUsageItems(plan.usageItems),
        clarified: !!plan.needsClarification,
      };
    }

    const moa = await runMoa(messages, spec.proposers, spec.aggregator, 1, undefined, undefined, signal);
    return { final: moa.final, usageItems: asBenchUsageItems(moa.usageItems) };
  }

  const system = config.workdir ? SOLO_PLAN_SYS : SOLO_CHAT_SYS;
  const response = await callModel({
    provider: spec.model.provider,
    model: spec.model.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `${config.prompt}${NO_CLARIFY_NOTE}` },
    ],
    workdir: config.workdir,
    planMode: !!config.workdir,
    sandbox: config.workdir && spec.model.provider === "codex-cli" ? "read-only" : undefined,
    signal,
  });
  const usageItems: BenchUsageItem[] = [
    {
      provider: spec.model.provider,
      model: spec.model.model,
      role: "proposer",
      ...response.usage,
      cost: estimateCost(spec.model.model, response.usage.prompt_tokens, response.usage.completion_tokens),
      sessionId: response.sessionId,
    },
  ];
  return { final: response.content, usageItems };
}

// Execution contender: produce working code, then score it deterministically.
//  - mode:  run the plan mode (read-only) → reset to a clean tree → hand the
//           plan to the fixed `executor`, which writes the code.
//  - solo:  no planning; the solo model implements the task directly.
// Either way the task's verifier scores the resulting git diff (pass@1).
async function runExecutionContender(
  config: BenchConfig,
  result: ContenderResult,
  task: BenchTask | undefined,
  signal: AbortSignal,
): Promise<ContenderOutput> {
  const spec = result.spec;
  const workdir = config.workdir!;
  const usageItems: BenchUsageItem[] = [];
  let planText: string | undefined;
  let executor: ModelRef;
  let execInstruction: string;

  if (spec.kind === "mode") {
    const messages: ChatMessage[] = [{ role: "user", content: `${config.prompt}${NO_CLARIFY_NOTE}` }];
    const plan = await runPlan(
      messages,
      spec.proposers,
      spec.aggregator,
      spec.mode,
      workdir,
      undefined,
      undefined,
      spec.stageModels,
      signal,
    );
    usageItems.push(...asBenchUsageItems(plan.usageItems));
    planText = plan.final;
    if (plan.needsClarification || hasClarifyMarker(plan.final)) {
      return { final: planText, usageItems, clarified: true };
    }
    // Give the executor a clean tree: undo any scratch plan files the read-only
    // planning stage wrote, so the diff we score is purely the executor's work.
    if (task?.repos.length) await resetSnapshot(task);
    executor = config.executor ?? DEFAULT_EXECUTOR;
    execInstruction = `Implement the task below by following the provided plan. The plan is your design; you are responsible for turning it into working code.\n\nTASK:\n${config.prompt}\n\nPLAN:\n${planText}`;
  } else {
    executor = spec.model;
    execInstruction = `${config.prompt}\n\nImplement this fully in the working directory now. Make all necessary code changes.`;
  }

  const execResponse = await callModel({
    provider: executor.provider,
    model: executor.model,
    messages: [
      { role: "system", content: EXEC_SYS },
      { role: "user", content: execInstruction },
    ],
    workdir,
    planMode: false,
    sandbox: executor.provider === "codex-cli" ? "workspace-write" : undefined,
    signal,
  });
  usageItems.push({
    provider: executor.provider,
    model: executor.model,
    role: "aggregator",
    ...execResponse.usage,
    cost: estimateCost(executor.model, execResponse.usage.prompt_tokens, execResponse.usage.completion_tokens),
    sessionId: execResponse.sessionId,
  });

  let verifier: VerifierResult;
  try {
    verifier = await runVerifier(task!.verifier!, workdir, task);
  } catch (e: any) {
    verifier = {
      resolved: false,
      passedSteps: 0,
      totalSteps: task!.verifier!.steps.length,
      hardTotal: task!.verifier!.steps.filter((s) => !s.soft).length,
      hardPassed: 0,
      steps: [],
      error: e?.message ?? String(e),
    };
  }

  return {
    final: executionFinal(planText, execResponse.content, verifier, `${executor.provider}/${executor.model}`),
    usageItems,
    verifier,
  };
}

function executionFinal(
  planText: string | undefined,
  execContent: string,
  v: VerifierResult,
  executorLabel: string,
): string {
  const verdict = v.error
    ? `⚠️ verifier error — ${v.error}`
    : `${v.resolved ? "RESOLVED ✓" : "NOT RESOLVED ✗"} · ${v.hardPassed}/${v.hardTotal} hard checks · ${v.passedSteps}/${v.totalSteps} total`;
  const lines: string[] = [`**Executor:** ${executorLabel}`, `**Verification:** ${verdict}`];
  if (v.steps.length) {
    lines.push("");
    for (const s of v.steps) {
      lines.push(`- ${s.passed ? "✅" : "❌"} ${s.soft ? "_(soft)_ " : ""}${s.label}${s.detail ? ` — ${s.detail}` : ""}`);
    }
  }
  if (v.diffStat) lines.push("", "```", v.diffStat, "```");
  if (execContent?.trim()) lines.push("", "<details><summary>Executor notes</summary>", "", execContent.trim(), "", "</details>");
  if (planText?.trim()) lines.push("", "<details><summary>Plan (mode output)</summary>", "", planText.trim(), "", "</details>");
  return lines.join("\n");
}

const EMPTY_CRITERIA: Record<BenchCriterion, number> = Object.fromEntries(
  BENCH_CRITERIA.map((c) => [c, 0]),
) as Record<BenchCriterion, number>;

// Build the ranking from deterministic verifier verdicts (no judge passes).
// Rank by resolved first (the pass@1 headline), then by step-pass ratio as a
// finer tiebreak. Reps aggregate via worstRep like the judged path.
function summarizeExecution(run: BenchRun): BenchSummaryRow[] {
  const rows: BenchSummaryRow[] = [];
  run.results.forEach((result, resultIndex) => {
    const v = result.verifier;
    if (!v) return;
    const composite = v.totalSteps ? (v.passedSteps / v.totalSteps) * 100 : 0;
    rows.push({
      resultIndex,
      composite,
      spread: 0,
      perCriterion: EMPTY_CRITERIA,
      passes: 1,
      scoreSource: "verifier",
      resolved: v.resolved,
      hardPassed: v.hardPassed,
      hardTotal: v.hardTotal,
    });
  });

  if (run.config.reps >= 2) {
    const bySpec = new Map<string, BenchSummaryRow[]>();
    for (const row of rows) {
      const key = JSON.stringify(run.results[row.resultIndex]?.spec ?? {});
      const list = bySpec.get(key) ?? [];
      list.push(row);
      bySpec.set(key, list);
    }
    for (const list of bySpec.values()) {
      if (list.length < 2) continue;
      const worst = Math.min(...list.map((row) => row.composite));
      for (const row of list) row.worstRep = worst;
    }
  }

  return rows.sort((a, b) => Number(b.resolved) - Number(a.resolved) || b.composite - a.composite);
}

async function judgeRun(run: BenchRun, signal: AbortSignal, task?: BenchTask, onlyIndices?: number[]) {
  const doneIndices = run.results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => result.status === "done" && !!result.final?.trim())
    .map(({ index }) => index);

  if (!doneIndices.length) return;

  // The rubric call scores ALL finished candidates side-by-side. Only the
  // checklist pass (the expensive per-candidate part) is restricted to
  // `onlyIndices` on an extension, so incumbents are not re-judged / re-paid.
  const doneSet = new Set(doneIndices);
  const checklistIndices = onlyIndices ? onlyIndices.filter((i) => doneSet.has(i)) : doneIndices;
  const checklistSet = new Set(checklistIndices);
  const hasChecklist = !!run.config.checklist?.length;
  const checklistTotal = hasChecklist ? checklistIndices.length : 0;

  run.status = "judging";

  const judges = run.config.judges?.length ? run.config.judges : run.config.judge ? [run.config.judge] : [DEFAULT_JUDGE];

  // Pre-create the full roadmap up front (all passes × judges as "pending"),
  // continuing the pass numbering after any existing passes (extensions add new
  // passes). The UI immediately shows the whole judging queue.
  const basePass = run.judgePasses.reduce((max, pass) => Math.max(max, pass.pass), 0);
  const newPasses: JudgePass[] = [];
  for (let pass = 1; pass <= run.config.judgePasses; pass++) {
    for (let judgeIndex = 0; judgeIndex < judges.length; judgeIndex++) {
      const judgePass: JudgePass = {
        pass: basePass + pass,
        judgeIndex,
        judge: judges[judgeIndex],
        order: shuffle(doneIndices),
        scores: [],
        status: "pending",
        checklistDone: 0,
        checklistTotal,
      };
      run.judgePasses.push(judgePass);
      newPasses.push(judgePass);
    }
  }
  await persist(run);

  for (const judgePass of newPasses) {
    if (signal.aborted) throw new RunStoppedError([]);
    const judge = judgePass.judge!;
    judgePass.status = "running";
    judgePass.startedAt = Date.now();
    judgePass.step = "rubric";
    await persist(run);

    if (task?.repos.length) await resetSnapshot(task);
    try {
      const response = await callModel({
        provider: judge.provider,
        model: judge.model,
        messages: [
          { role: "system", content: JUDGE_SYS },
          { role: "user", content: buildJudgePrompt(run, judgePass.order) },
        ],
        workdir: run.config.workdir,
        planMode: !!run.config.workdir,
        sandbox: run.config.workdir && judge.provider === "codex-cli" ? "read-only" : undefined,
        signal,
      });
      judgePass.usage = addUsage(judgePass.usage, response.usage);
      judgePass.scores = parseJudgeScores(response.content, judgePass.order);
      await appendUsageSafe(run.id, [
        {
          provider: judge.provider,
          model: judge.model,
          role: "aggregator",
          ...response.usage,
          cost: estimateCost(judge.model, response.usage.prompt_tokens, response.usage.completion_tokens),
        },
      ]);

      if (hasChecklist) {
        judgePass.step = "checklist";
        await persist(run);
        for (const resultIndex of judgePass.order) {
          if (!checklistSet.has(resultIndex)) continue;
          if (signal.aborted) throw new RunStoppedError([]);
          if (task?.repos.length) await resetSnapshot(task);
          const checklistResponse = await callModel({
            provider: judge.provider,
            model: judge.model,
            messages: [
              { role: "system", content: CHECKLIST_JUDGE_SYS },
              { role: "user", content: buildChecklistPrompt(run, resultIndex, run.config.checklist!) },
            ],
            workdir: run.config.workdir,
            planMode: !!run.config.workdir,
            sandbox: run.config.workdir && judge.provider === "codex-cli" ? "read-only" : undefined,
            signal,
          });
          judgePass.usage = addUsage(judgePass.usage, checklistResponse.usage);
          await appendUsageSafe(run.id, [
            {
              provider: judge.provider,
              model: judge.model,
              role: "aggregator",
              ...checklistResponse.usage,
              cost: estimateCost(judge.model, checklistResponse.usage.prompt_tokens, checklistResponse.usage.completion_tokens),
            },
          ]);
          const verdicts = parseJudgeChecklist(checklistResponse.content, run.config.checklist!);
          const score = judgePass.scores.find((item) => item.resultIndex === resultIndex);
          if (score) {
            score.checklist = verdicts;
            score.checklistScore = scoreChecklist(run.config.checklist!, verdicts);
          }
          judgePass.checklistDone = (judgePass.checklistDone ?? 0) + 1;
          await persist(run); // heartbeat: updatedAt moves at least once per judge call
        }
      }
      judgePass.status = "done";
      judgePass.endedAt = Date.now();
      delete judgePass.step;
    } catch (e: any) {
      if (signal.aborted || stoppedMessage(e)) throw new RunStoppedError([]);
      judgePass.error = e?.message ?? String(e);
      judgePass.status = "error";
      judgePass.endedAt = Date.now();
      delete judgePass.step;
    }
    await persist(run);
  }
}

function buildJudgePrompt(run: BenchRun, order: number[]): string {
  const grounded =
    run.config.workdir
      ? `\nThe working directory is available to you at: ${run.config.workdir}\nVerify a sample of concrete code claims before scoring groundedness.\n`
      : "";
  const candidates = order
    .map((resultIndex, i) => {
      const result = run.results[resultIndex];
      return `### Candidate ${candidateName(i)}\n${result.final?.trim() ?? ""}`;
    })
    .join("\n\n---\n\n");
  return `Original request:
${run.config.prompt}
${grounded}
Rubric:
- groundedness: repo/code claims are real and checked where possible.
- requirementCoverage: request requirements are covered or explicitly descoped.
- actionability: implementation steps are concrete.
- testingQuality: testing is grounded and satisfiable.
- clarityScope: organization is clear and scope is proportional.

Candidates are anonymized and shuffled. Score each candidate independently.

${candidates}`;
}

function buildChecklistPrompt(run: BenchRun, resultIndex: number, checklist: ChecklistItem[]): string {
  const grounded =
    run.config.workdir
      ? `\nWorking directory: ${run.config.workdir}\nVerify concrete path/symbol claims against this code when relevant.\n`
      : "";
  const items = checklist.map((item) => `- ${item.id} (${item.points} pts, ${item.axis}): ${item.text}`).join("\n");
  const candidate = run.results[resultIndex];
  return `Original request:
${run.config.prompt}
${grounded}
Checklist:
${items}

Candidate plan:
${candidate.final?.trim() ?? ""}`;
}

export function summarize(run: BenchRun): BenchSummaryRow[] {
  const byResult = new Map<number, JudgeScore[]>();
  for (const pass of run.judgePasses) {
    if (pass.error) continue;
    for (const score of pass.scores) {
      const list = byResult.get(score.resultIndex) ?? [];
      list.push(score);
      byResult.set(score.resultIndex, list);
    }
  }

  const rows: BenchSummaryRow[] = [];
  for (const [resultIndex, scores] of byResult) {
    if (!scores.length) continue;
    const checklistScores = scores
      .map((score) => score.checklistScore)
      .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
    const scoreSource = checklistScores.length ? "checklist" : "rubric";
    const composites = checklistScores.length ? checklistScores : scores.map((score) => score.composite);
    const perCriterion = Object.fromEntries(
      BENCH_CRITERIA.map((criterion) => [
        criterion,
        mean(scores.map((score) => score.criteria[criterion] ?? 0)),
      ]),
    ) as Record<BenchCriterion, number>;
    rows.push({
      resultIndex,
      composite: mean(composites),
      spread: Math.max(...composites) - Math.min(...composites),
      perCriterion,
      passes: scores.length,
      checklistScore: checklistScores.length ? mean(checklistScores) : undefined,
      scoreSource,
    });
  }
  if (run.config.reps >= 2) {
    const bySpec = new Map<string, BenchSummaryRow[]>();
    for (const row of rows) {
      const key = JSON.stringify(run.results[row.resultIndex]?.spec ?? {});
      const list = bySpec.get(key) ?? [];
      list.push(row);
      bySpec.set(key, list);
    }
    for (const list of bySpec.values()) {
      if (list.length < 2) continue;
      const worst = Math.min(...list.map((row) => row.composite));
      for (const row of list) row.worstRep = worst;
    }
  }
  return rows.sort((a, b) => b.composite - a.composite);
}

function parseJudgeScores(content: string, order: number[]): JudgeScore[] {
  const raw = extractJsonArray(content);
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("Judge returned JSON that was not an array.");

  const candidateToResult = new Map(order.map((resultIndex, i) => [candidateName(i), resultIndex]));
  const out: JudgeScore[] = [];
  for (const item of arr) {
    const rawCandidate = String(item?.candidate ?? item?.name ?? "").trim();
    const candidate = rawCandidate.replace(/^candidate\s+/i, "").trim().toUpperCase();
    const resultIndex = candidateToResult.get(candidate);
    if (resultIndex === undefined) continue;
    const criteria = parseCriteria(item?.scores ?? item?.criteria ?? item);
    out.push({
      resultIndex,
      criteria,
      composite: mean(BENCH_CRITERIA.map((key) => criteria[key])),
      rationale: typeof item?.rationale === "string" ? item.rationale : "",
    });
  }
  if (!out.length) throw new Error("Judge JSON did not contain any recognized candidate scores.");
  return out;
}

export function parseJudgeChecklist(
  content: string,
  checklist: ChecklistItem[],
): { itemId: string; verdict: "yes" | "no" | "unknown" }[] {
  const raw = extractJsonValue(content);
  const parsed = JSON.parse(raw);
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed?.checklist) ? parsed.checklist : [];
  const byId = new Map<string, "yes" | "no" | "unknown">();
  for (const item of arr) {
    const itemId = String(item?.itemId ?? item?.id ?? "").trim();
    const verdictRaw = String(item?.verdict ?? item?.answer ?? "").trim().toLowerCase();
    const verdict = verdictRaw === "yes" ? "yes" : verdictRaw === "no" ? "no" : "unknown";
    if (itemId) byId.set(itemId, verdict);
  }
  return checklist.map((item) => ({ itemId: item.id, verdict: byId.get(item.id) ?? "unknown" }));
}

export function scoreChecklist(
  checklist: ChecklistItem[],
  verdicts: { itemId: string; verdict: "yes" | "no" | "unknown" }[],
): number {
  const verdictById = new Map(verdicts.map((item) => [item.itemId, item.verdict]));
  const maxPositive = checklist.filter((item) => item.points > 0).reduce((sum, item) => sum + item.points, 0);
  if (maxPositive <= 0) return 0;
  const earned = checklist.reduce((sum, item) => {
    if (verdictById.get(item.id) !== "yes") return sum;
    return sum + item.points;
  }, 0);
  return Math.max(0, Math.min(100, (earned / maxPositive) * 100));
}

function parseCriteria(raw: any): Record<BenchCriterion, number> {
  const normalized = new Map<string, number>();
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      normalized.set(key.toLowerCase().replace(/[^a-z0-9]/g, ""), Math.max(0, Math.min(10, n)));
    }
  }
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = normalized.get(key);
      if (value !== undefined) return value;
    }
    return 0;
  };
  return {
    groundedness: pick("groundedness"),
    requirementCoverage: pick("requirementcoverage", "coverage", "requirementscoverage"),
    actionability: pick("actionability", "concreteness"),
    testingQuality: pick("testingquality", "testing", "testquality"),
    clarityScope: pick("clarityscope", "clarityandscope", "clarity", "scope"),
  };
}

function extractJsonArray(text: string): string {
  return extractJsonByDelimiters(text, "[", "]");
}

function extractJsonValue(text: string): string {
  try {
    return extractJsonByDelimiters(text, "[", "]");
  } catch {
    return extractJsonByDelimiters(text, "{", "}");
  }
}

function extractJsonByDelimiters(text: string, open: "[" | "{", close: "]" | "}"): string {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === close && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`Judge did not return a JSON ${open === "[" ? "array" : "object"}.`);
}

function candidateName(i: number): string {
  let n = i;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
