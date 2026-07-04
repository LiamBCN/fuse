import type { Mode, ModelRef, StageModelMap, Usage, UsageLimitDeltas } from "./types";
import type { ChecklistItem } from "./bench-tasks";

export const BENCH_CRITERIA = [
  "groundedness",
  "requirementCoverage",
  "actionability",
  "testingQuality",
  "clarityScope",
] as const;

export type BenchCriterion = (typeof BENCH_CRITERIA)[number];

export const BENCH_CRITERION_LABELS: Record<BenchCriterion, string> = {
  groundedness: "Groundedness",
  requirementCoverage: "Coverage",
  actionability: "Actionability",
  testingQuality: "Testing",
  clarityScope: "Clarity",
};

export interface BenchUsageItem {
  provider: string;
  model: string;
  role: "proposer" | "aggregator";
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  sessionId?: string;
}

export type ContenderSpec =
  | {
      kind: "mode";
      mode: Mode;
      proposers: ModelRef[];
      aggregator: ModelRef;
      stageModels?: StageModelMap;
    }
  | { kind: "solo"; model: ModelRef };

// Human-readable label for a contender spec. Lives here (dependency-light) so
// both bench-store and bench-publish can use it without an import cycle.
export function contenderLabel(spec: ContenderSpec): string {
  if (spec.kind === "solo") return `${spec.model.provider}/${spec.model.model} · solo`;
  return `${spec.mode} · ${spec.proposers.map((p) => p.model).join(" + ")} → ${spec.aggregator.model}`;
}

export interface BenchConfig {
  prompt: string;
  workdir?: string;
  contenders: ContenderSpec[];
  judge?: ModelRef;
  judges?: ModelRef[];
  judgePasses: number;
  reps: number;
  taskId?: string;
  taskTitle?: string;
  taskSummary?: string;
  checklist?: ChecklistItem[];
  // Execution mode: instead of scoring plan prose with an LLM judge, each
  // contender's plan is handed to a fixed `executor` model that writes real
  // code, and the result is scored by the task's deterministic verifier
  // (pass@1, all-or-nothing on the hard steps). Solo contenders skip planning
  // and execute the task directly with their own model.
  execute?: boolean;
  executor?: ModelRef; // model that implements a mode's plan (held constant across mode contenders)
}

// A verifier step. `run` executes a shell command (exit 0 = pass). `diff`
// tests a regex against the ADDED lines of the contender's git diff. `grep`
// tests a regex against file/tree contents. `soft` steps are informational:
// they show in the breakdown and count toward the step-pass ratio but do NOT
// gate the binary `resolved` verdict.
export type VerifierStep =
  | { kind: "run"; label: string; cmd: string; cwd?: string; soft?: boolean }
  | { kind: "diff"; label: string; pattern: string; repo?: string; want?: boolean; flags?: string; soft?: boolean }
  | { kind: "grep"; label: string; pattern: string; path: string; want?: boolean; flags?: string; soft?: boolean };

export interface BenchVerifier {
  steps: VerifierStep[];
  timeoutMs?: number; // per-`run`-step timeout; default 120000
}

export interface VerifierStepResult {
  label: string;
  kind: "run" | "diff" | "grep";
  soft: boolean;
  passed: boolean;
  detail?: string; // exit code / matched excerpt / stderr tail
}

export interface VerifierResult {
  resolved: boolean; // every non-soft step passed
  passedSteps: number; // steps that passed (incl. soft)
  totalSteps: number;
  hardTotal: number;
  hardPassed: number;
  steps: VerifierStepResult[];
  diffStat?: string; // `git diff --stat` of the executor's changes
  error?: string; // harness-level failure (couldn't run the verifier at all)
}

export type ContenderStatus = "pending" | "running" | "done" | "error" | "clarified" | "stopped" | "rateLimited";

export interface ContenderResult {
  spec: ContenderSpec;
  rep: number;
  status: ContenderStatus;
  final?: string;
  error?: string;
  elapsedMs?: number;
  usage?: Usage;
  usageItems?: BenchUsageItem[];
  limitDelta?: UsageLimitDeltas;
  startedAt?: number;
  endedAt?: number;
  verifier?: VerifierResult; // execution runs only: deterministic pass@1 verdict
  extension?: boolean; // added to a finished run via "Add contenders" (badged in the UI)
}

export interface JudgeScore {
  resultIndex: number;
  criteria: Record<BenchCriterion, number>;
  composite: number;
  rationale: string;
  checklist?: { itemId: string; verdict: "yes" | "no" | "unknown" }[];
  checklistScore?: number;
}

export type JudgePassStatus = "pending" | "running" | "done" | "error" | "stopped";

export interface JudgePass {
  pass: number;
  judgeIndex?: number;
  judge?: ModelRef;
  order: number[];
  scores: JudgeScore[];
  error?: string;
  usage?: Usage;
  // Live progress (all optional so runs persisted before this change still parse).
  status?: JudgePassStatus;
  startedAt?: number;
  endedAt?: number;
  step?: "rubric" | "checklist"; // what the pass is doing right now
  checklistDone?: number; // candidates whose checklist call finished
  checklistTotal?: number; // candidates to checklist-verify this pass
}

export type ScoreSource = "checklist" | "rubric" | "verifier";

export interface BenchSummaryRow {
  resultIndex: number;
  composite: number;
  spread: number;
  perCriterion: Record<BenchCriterion, number>;
  passes: number;
  checklistScore?: number;
  worstRep?: number;
  scoreSource?: ScoreSource;
  // Verifier scoring (execution runs). `composite` is the step-pass ratio as a
  // percent; `resolved` is the all-hard-steps-pass verdict (the headline).
  resolved?: boolean;
  hardPassed?: number;
  hardTotal?: number;
}

export type BenchRunStatus = "running" | "judging" | "done" | "error" | "stopped";

export interface BenchPublishState {
  at: number;
  commit: string;
  path: string; // repo-relative path of the exported JSON
  pushed?: boolean; // false when the commit landed locally but push failed
}

export interface BenchRun {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: BenchRunStatus;
  config: BenchConfig;
  results: ContenderResult[];
  judgePasses: JudgePass[];
  summary?: BenchSummaryRow[];
  error?: string;
  published?: BenchPublishState; // set once exported to the git results repo
  publishError?: string; // best-effort auto-publish failure, surfaced but non-fatal
  extendedFrom?: string; // id of the shared/original run this was cloned from to extend
  shared?: boolean; // transient: this detail was loaded from the git results repo, not local (read-only). Never persisted locally.
}

export interface BenchRunSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: BenchRunStatus;
  taskId?: string;
  taskTitle?: string;
  taskSummary?: string;
  workdir?: string;
  promptExcerpt: string;
  contenderLabels: string[];
  judgeLabels: string[];
  resultCount: number;
  completedCount: number;
  judgePasses: number;
  reps: number;
  checklistCount: number;
  scoreSource?: ScoreSource;
  execute?: boolean;
  resolvedCount?: number; // execution runs: contenders that fully resolved
  attemptCount?: number; // execution runs: contenders with a verifier verdict
  elapsedMs?: number;
  totalTokens?: number;
  totalLimitSessionPct?: number;
  best?: { label: string; composite: number; spread: number; scoreSource?: ScoreSource; resolved?: boolean };
  // Judge-phase progress (for live cards while status === "judging").
  judgeCallsDone?: number;
  judgeCallsTotal?: number;
  published?: boolean; // exported to the git results repo
  shared?: boolean; // loaded from the git results repo, not the local data dir (read-only)
}
