import assert from "node:assert/strict";
import { extendBenchRun, summarize, scoreChecklist, parseJudgeChecklist } from "./bench";
import { judgeCallProgress, writeBenchRun, deleteBenchRun } from "./bench-store";
import { sanitizeRun } from "./bench-publish";
import { contenderLabel } from "./bench-types";
import { ALL_BUILTIN_TASKS, DEFAULT_TASKS } from "./bench-tasks";
import { registerRun } from "./run-control";
import { BENCH_CRITERIA, type BenchCriterion, type BenchRun, type ContenderSpec, type JudgeScore } from "./bench-types";

const crit = (v: number): Record<BenchCriterion, number> =>
  Object.fromEntries(BENCH_CRITERIA.map((c) => [c, v])) as Record<BenchCriterion, number>;

const soloSpec = (model: string): ContenderSpec => ({ kind: "solo", model: { provider: "claude-cli", model } });

function baseRun(over: Partial<BenchRun> = {}): BenchRun {
  return {
    id: "test-run",
    createdAt: 1000,
    updatedAt: 2000,
    status: "done",
    config: { prompt: "p", contenders: [], judgePasses: 2, reps: 1 },
    results: [],
    judgePasses: [],
    ...over,
  };
}

// ---- summarize(): checklist source wins across old + extension passes ----
{
  const score = (resultIndex: number, composite: number, checklistScore?: number): JudgeScore => ({
    resultIndex,
    criteria: crit(composite),
    composite,
    rationale: "",
    ...(checklistScore !== undefined ? { checklistScore } : {}),
  });

  const run = baseRun({
    results: [
      { spec: soloSpec("old"), rep: 1, status: "done", final: "x" },
      { spec: soloSpec("new"), rep: 1, status: "done", final: "y", extension: true },
    ],
    judgePasses: [
      // Original pass: checklist verdict for the incumbent only (idx 0).
      { pass: 1, judge: { provider: "claude-cli", model: "j" }, order: [0], scores: [score(0, 7, 80)], status: "done" },
      // Extension pass: rubric scores BOTH candidates side-by-side; checklist
      // ran only for the new candidate (idx 1).
      {
        pass: 2,
        judge: { provider: "claude-cli", model: "j" },
        order: [0, 1],
        scores: [score(0, 5) /* rubric-only, no checklistScore */, score(1, 6, 90)],
        status: "done",
      },
    ],
  });

  const rows = summarize(run);
  const byIndex = new Map(rows.map((r) => [r.resultIndex, r]));
  const old = byIndex.get(0)!;
  const neu = byIndex.get(1)!;

  // Checklist source must win for the incumbent: composite = the single 80,
  // NOT averaged with the extension's rubric 5 (no double counting).
  assert.equal(old.scoreSource, "checklist");
  assert.equal(old.composite, 80);
  assert.equal(old.checklistScore, 80);
  // New candidate scored by its own checklist, side-by-side.
  assert.equal(neu.scoreSource, "checklist");
  assert.equal(neu.composite, 90);
  // Ranking: new (90) ahead of old (80).
  assert.equal(rows[0].resultIndex, 1);
}

// ---- judgeCallProgress(): fresh, legacy, extended ----
{
  // Fresh, fully pre-created, nothing done yet: 2 passes × 2 judges, checklist
  // over 3 candidates ⇒ 4 passes × (1 rubric + 3 checklist) = 16 calls.
  const fresh = baseRun({
    status: "judging",
    config: {
      prompt: "p",
      contenders: [],
      judgePasses: 2,
      reps: 1,
      judges: [
        { provider: "claude-cli", model: "a" },
        { provider: "codex-cli", model: "b" },
      ],
      checklist: [
        { id: "c1", text: "", points: 1, axis: "coverage" },
        { id: "c2", text: "", points: 1, axis: "coverage" },
      ],
    },
    results: [0, 1, 2].map(() => ({ spec: soloSpec("m"), rep: 1, status: "pending" as const })),
    judgePasses: Array.from({ length: 4 }, (_, i) => ({
      pass: 1 + Math.floor(i / 2),
      judgeIndex: i % 2,
      judge: { provider: "claude-cli" as const, model: "a" },
      order: [0, 1, 2],
      scores: [],
      status: "pending" as const,
      checklistDone: 0,
      checklistTotal: 3,
    })),
  });
  assert.deepEqual(judgeCallProgress(fresh), { done: 0, total: 16 });

  // Legacy done run: passes carry NO progress fields, only scored candidates.
  const legacyScore = (i: number): JudgeScore => ({ resultIndex: i, criteria: crit(7), composite: 7, rationale: "", checklistScore: 70 });
  const legacy = baseRun({
    config: { prompt: "p", contenders: [], judgePasses: 2, reps: 1, judges: [{ provider: "claude-cli", model: "a" }, { provider: "codex-cli", model: "b" }], checklist: [{ id: "c1", text: "", points: 1, axis: "coverage" }] },
    results: [0, 1, 2].map(() => ({ spec: soloSpec("m"), rep: 1, status: "done" as const, final: "x" })),
    judgePasses: Array.from({ length: 4 }, () => ({
      pass: 1,
      judge: { provider: "claude-cli" as const, model: "a" },
      order: [0, 1, 2],
      scores: [legacyScore(0), legacyScore(1), legacyScore(2)],
    })),
  });
  // legacyChecklistPer = 3 done results ⇒ 4 × (1 + 3) = 16 total; all complete.
  assert.deepEqual(judgeCallProgress(legacy), { done: 16, total: 16 });

  // Extended: old + new passes, all done, 1 checklist each ⇒ 4 × (1+1) = 8.
  const extScore = (i: number): JudgeScore => ({ resultIndex: i, criteria: crit(6), composite: 6, rationale: "", checklistScore: 60 });
  const extended = baseRun({
    config: { prompt: "p", contenders: [], judgePasses: 1, reps: 1, judges: [{ provider: "claude-cli", model: "a" }, { provider: "codex-cli", model: "b" }], checklist: [{ id: "c1", text: "", points: 1, axis: "coverage" }] },
    results: [0, 1].map(() => ({ spec: soloSpec("m"), rep: 1, status: "done" as const, final: "x" })),
    judgePasses: [1, 1, 2, 2].map((p, i) => ({
      pass: p,
      judgeIndex: i % 2,
      judge: { provider: "claude-cli" as const, model: "a" },
      order: [0, 1],
      scores: [extScore(0)],
      status: "done" as const,
      checklistDone: 1,
      checklistTotal: 1,
    })),
  });
  assert.deepEqual(judgeCallProgress(extended), { done: 8, total: 8 });

  // Execution runs and un-judged runs report no judge progress.
  assert.equal(judgeCallProgress(baseRun({ config: { prompt: "p", contenders: [], judgePasses: 2, reps: 1, execute: true } })), undefined);
  assert.equal(judgeCallProgress(baseRun({ status: "done", judgePasses: [] })), undefined);
}

// ---- sanitizeRun(): strips absolute paths everywhere + idempotent ----
{
  const wd = "/Users/liam/Library/Application Support/Fuse/data/bench/snapshots/task/backend";
  const run = baseRun({
    config: { prompt: "do it", workdir: wd, contenders: [], judgePasses: 1, reps: 1 },
    results: [
      {
        spec: soloSpec("m"),
        rep: 1,
        status: "done",
        endedAt: 5000,
        final: `Edited ${wd}/src/index.ts and ${wd}/../frontend/app.tsx`,
      },
    ],
    judgePasses: [
      {
        pass: 1,
        judge: { provider: "claude-cli", model: "j" },
        order: [0],
        scores: [{ resultIndex: 0, criteria: crit(8), composite: 8, rationale: `checked ${wd}/src` }],
        status: "done",
        endedAt: 6000,
      },
    ],
    published: { at: 1, commit: "abc", path: "x" },
    publishError: "boom",
    shared: true,
  });

  const original = JSON.stringify(run);
  const clean = sanitizeRun(run);

  assert.equal(JSON.stringify(run), original, "sanitizeRun must not mutate its input");
  assert.equal(clean.config.workdir, "<workdir>");
  const cleanJson = JSON.stringify(clean);
  assert.ok(!cleanJson.includes("/Users/liam"), "no absolute /Users path survives");
  assert.ok(!cleanJson.includes(wd), "the workdir string is fully replaced");
  assert.ok(cleanJson.includes("<workdir>/src/index.ts"), "workdir-prefixed output paths are rewritten");
  assert.equal(clean.published, undefined);
  assert.equal(clean.publishError, undefined);
  assert.equal(clean.shared, undefined);
  // updatedAt normalized to logical completion (latest endedAt) for stability.
  assert.equal(clean.updatedAt, 6000);

  // Idempotent: re-sanitizing is a no-op.
  assert.equal(JSON.stringify(sanitizeRun(clean)), cleanJson);

  // Re-publish idempotency: two runs differing only in publish bookkeeping /
  // updatedAt sanitize to byte-identical exports.
  const before = sanitizeRun(baseRun({ ...run, published: undefined, publishError: undefined, shared: undefined, updatedAt: 9 }));
  const after = sanitizeRun(baseRun({ ...run, published: { at: 2, commit: "def", path: "y" }, updatedAt: 99999 }));
  assert.equal(JSON.stringify(before), JSON.stringify(after));
}

// ---- extendBenchRun(): a live run is rejected before any work ----
async function testExtendGuard() {
  const id = "test-extend-guard-run";
  const live = baseRun({ id, status: "judging", config: { prompt: "p", contenders: [soloSpec("m")], judgePasses: 1, reps: 1 } });
  await writeBenchRun(live);
  // Register a live controller so surfaceStaleRun keeps it "judging" (not stale).
  const unregister = registerRun(`bench:${id}`, new AbortController());
  let rejected = false;
  try {
    await extendBenchRun(id, [soloSpec("added")]);
  } catch (e: any) {
    rejected = /running/i.test(e?.message ?? "");
  } finally {
    unregister();
    await deleteBenchRun(id);
  }
  assert.equal(rejected, true, "extending a live run must throw");
}

// ---- checklist scoring helpers ----
{
  const checklist = [
    { id: "a", text: "", points: 4, axis: "coverage" as const },
    { id: "b", text: "", points: 6, axis: "coverage" as const },
    { id: "pen", text: "", points: -5, axis: "scope" as const },
  ];
  // Only "a" satisfied ⇒ 4 / (4+6) = 40%.
  assert.equal(scoreChecklist(checklist, [{ itemId: "a", verdict: "yes" }, { itemId: "b", verdict: "no" }]), 40);
  const parsed = parseJudgeChecklist('[{"itemId":"a","verdict":"yes"},{"itemId":"b","verdict":"unknown"}]', checklist);
  assert.equal(parsed.find((p) => p.itemId === "a")?.verdict, "yes");
  assert.equal(parsed.find((p) => p.itemId === "pen")?.verdict, "unknown"); // missing ⇒ unknown
}

// ---- portable task suite: exactly two visible tasks, Fuse task is git-cloneable ----
{
  assert.equal(DEFAULT_TASKS.length, 2, "the picker shows exactly two tasks");
  assert.deepEqual(DEFAULT_TASKS.map((t) => t.id), ["migma-author-location-fields", "fuse-mode-badges-live-run"]);
  const fuse = DEFAULT_TASKS.find((t) => t.id === "fuse-mode-badges-live-run")!;
  const repo = fuse.repos[0];
  assert.ok(repo.gitUrl && /github\.com/.test(repo.gitUrl), "Fuse task repo has a gitUrl fallback");
  assert.ok(repo.dirName, "Fuse task repo has a stable dirName");
  assert.ok(repo.pinnedCommit, "Fuse task repo is pinned");
  // Demoted tasks stay resolvable-by-id (parked, not deleted).
  assert.ok(ALL_BUILTIN_TASKS.some((t) => t.id === "migma-admin-panel-rbac"));
  assert.ok(ALL_BUILTIN_TASKS.some((t) => t.id === "migma-blog-dates"));
  assert.ok(!DEFAULT_TASKS.some((t) => t.id === "migma-admin-panel-rbac"), "RBAC is hidden from the picker");
}

// ---- contenderLabel ----
{
  assert.equal(contenderLabel(soloSpec("claude-sonnet-5")), "claude-cli/claude-sonnet-5 · solo");
  assert.equal(
    contenderLabel({ kind: "mode", mode: "recon", proposers: [{ provider: "claude-cli", model: "a" }], aggregator: { provider: "codex-cli", model: "b" } }),
    "recon · a → b",
  );
}

testExtendGuard()
  .then(() => console.log("bench.test.ts: all assertions passed"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
