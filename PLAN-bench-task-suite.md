# PLAN: Default benchmark task suite — lab-grade tasks for testing the modes

## Goal

Give the Benchmarks page a **library of default tasks** that reliably discriminate
between Fast / Relay / Recon and solo models, plus the ability to add **custom tasks
with any project**. Task design is grounded in how OpenAI, Anthropic, and the
community actually evaluate coding/agentic models (study summary below), adapted to
our deliverable: implementation *plans* against a real codebase, judged blind.

Primary target: **migma-both** (backend + frontend) — that's the real workload Fuse
plans for daily. Fuse itself gets one task as a generalization check. Details and the
reasoning in "Where the tasks run".

## Study: how the labs test, and what transfers to us

Condensed from OpenAI/Anthropic/community sources (URLs kept for reference):

| Source | What they do | What we take |
|---|---|---|
| SWE-bench Verified ([openai.com](https://openai.com/index/introducing-swe-bench-verified/)) | 500 human-validated tasks; ground truth = fail-to-pass tests at a **pinned commit**; deprecated in 2026 over training-data contamination | Pin a commit per task; human-validate each task once; private never-published tasks are inherently contamination-proof |
| PaperBench ([arxiv 2504.01848](https://arxiv.org/abs/2504.01848)) | Decomposes "did they replicate the paper" into a **rubric tree of binary leaf criteria**, LLM-judged one narrow question at a time, judge validated against humans once | Per-task **binary checklists** written against the real code, instead of only generic 0–10 vibes |
| HealthBench ([openai.com](https://openai.com/index/healthbench/)) | 48k rubric criteria with **point values −10..+10**; wrong/harmful content scores *negative* | **Negative points for fabrications** (nonexistent paths/symbols/flows) — already our known #1 failure mode from the 3-mode bench |
| MT-Bench / Arena ([arxiv 2306.05685](https://arxiv.org/abs/2306.05685)) | LLM judges ≈ human agreement, but only after debiasing: position bias (judge twice, swap order), verbosity bias, **self-enhancement bias** (Claude judge favors Claude ~+25%) | Keep shuffling; add optional **dual-family judge** (Claude + Codex averaged); instruct against length preference |
| Anthropic eval guidance ([anthropic.com](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), [statistics](https://www.anthropic.com/research/statistical-approach-to-model-evals)) | 20–50 tasks from **real past failures**; rubric bar = "two experts would independently agree"; compare systems by **paired per-task differences**; report mean ± SEM over ≥3 runs | Tasks come from our own shipped features; reps + paired comparison in the summary |
| Aider polyglot ([aider.chat](https://aider.chat/2024/12/21/polyglot.html)) | Kept only problems most models fail — benchmarks need **headroom** | Prefer hard cross-stack tasks; drop tasks where every contender ties |
| tau2-bench ([github](https://github.com/sierra-research/tau2-bench)) | **pass^k**: reliability = all k trials succeed, not best-of-k | With reps>1, surface worst-rep score, not just mean — a mode that's occasionally brilliant but flaky should look flaky |
| SWE-Lancer ([openai.com](https://openai.com/index/swe-lancer/)) | "SWE Manager" split grades *proposal selection* against the real hired engineer's decision | Our gold answers = the implementation that actually shipped for each past task |

**Top transferable principles:** (1) pin the world, (2) tasks from real work with a
known-good shipped answer, (3) binary per-task checklists over holistic scores,
(4) negative points for fabrication, (5) debias the judge (shuffle + cross-family),
(6) small-and-hard beats big-and-easy, (7) reps with paired per-task stats,
(8) hand-validate the judge once, then trust it.

## Where the tasks run — migma-both vs Fuse

**Decision: 3 of 5 default tasks target the migma repos, 1 targets Fuse, 1 is a
groundedness trap (also migma).** Rationale:

- migma-both is the actual daily workload — benchmark validity comes from matching it.
  Fuse (small, familiar, self-authored) gets one task purely to check the mode ranking
  generalizes to a different codebase shape.
- **But never against the live folder.** `/Users/liam/migma-both` today is unusable as
  a benchmark target as-is: `frontend` has 22 uncommitted changes, `backend` 6, and the
  tree is littered with 30+ prior `fuse-plan-*.md` files — including finished plans for
  the very tasks we'd benchmark. A contender could literally read a past winning plan
  (contamination), and the moving code makes any two runs incomparable (the SWE-bench
  lesson). All default tasks therefore run against **pinned snapshots** (below).
- Custom tasks may still point at any live folder — with a visible "not reproducible:
  workdir is not a pinned snapshot" warning when the dir is dirty or litter is detected.

## Snapshot system (pinning the world)

Per task: a snapshot dir at `DATA_DIR/bench/snapshots/<taskId>/` created by a new
`scripts/bench-snapshot.sh <taskId>` (and an API-triggered equivalent):

1. `git clone --local <repoPath> <snapshotDir>/<repoName>` for each repo the task
   targets (frontend and/or backend), then `git checkout <pinnedCommit>`.
2. Delete plan litter by pattern: `fuse-plan-*.md`, `*_PLAN.md`, `REVIEW-*.md`,
   `PARITY_FINDINGS.md` etc. (per-task `stripGlobs` list), commit the deletion locally
   so the tree is clean at a *new* deterministic commit.
3. Record `{ taskId, path, commit }` in the snapshot; a snapshot is immutable input.

**Reset between contenders:** plan modes write plan files into the workdir
(`FILE_NOTE` allows scratch files), so contender A's output must not be readable by
contender B. `lib/bench.ts` gets a `resetSnapshot(dir)` step that runs
`git checkout -- . && git clean -fd` in each snapshot repo before every contender and
before every judge pass. Cheap, and it also guarantees rep 2 starts identical to rep 1.

## The default task suite (v1: 5 tasks)

All five follow one recipe: a **real past request** (we have the exact prompts in the
`fuse-plan-*.md` filenames/headers), a **pinned pre-implementation commit**, and a
**checklist written by studying the implementation that actually shipped** (the merged
diff is the gold answer, per SWE-Lancer/Anthropic). Exact commits get picked during
Phase 1 authoring by walking `git log` for the commit just before each feature landed.

| # | Task | Target | Why it discriminates |
|---|---|---|---|
| T1 | Admin panel RBAC: three internal roles on top of existing JWT auth | backend + frontend (cross-stack) | Requires finding the real auth middleware, `requireAdmin()` call sites, and frontend guard; drafts that skip recon historically fabricated the gating story. Gold: the RBAC implementation + `PLAN-migma-admin-panel-roles.md` |
| T2 | Show published + last-updated dates on blog articles after edits | frontend | Small, deceptively simple; tests scope discipline (no invented backend work) and whether testing steps are grounded. Gold: the shipped date-display change |
| T3 | Author email autogeneration + article reassignment to migma team | backend + frontend | Cross-stack data-flow task; coverage-heavy request with several numbered requirements — tests requirement coverage. Gold: shipped implementation |
| T4 | Mode badges in chat/history + live expandable run diagram | **Fuse repo** @ commit `b5145e5`'s parent (pre-implementation) | Generalization check on a different, smaller codebase; we know the shipped answer intimately (`PLAN-mode-badges-and-live-run-view.md` + current code) |
| T5 | **Groundedness trap**: a request that presupposes behavior the app doesn't have (e.g. "extend the existing draft-articles workflow…", the exact flow all three modes fabricated tests for in the last bench) | frontend | Measures fabrication resistance directly: checklist items are mostly *negative-point* items; the right plan says "NOT FOUND / must be created first" |

Suite properties: 2 cross-stack, 2 single-repo, 1 trap; sized so a full
3-mode + 2-solo run finishes in an evening. Aider's headroom rule applies: after the
first full run, any task where all contenders score within noise gets replaced.

## Data model & code changes

### `lib/bench-tasks.ts` (new, client-safe)

```ts
export interface ChecklistItem {
  id: string;          // "t1-auth-middleware"
  text: string;        // "Identifies the JWT auth middleware and its role field as the extension point"
  points: number;      // positive = required content; negative = fabrication/scope penalty
  axis: "grounding" | "coverage" | "actionability" | "testing" | "scope";
}

export interface BenchTask {
  id: string;
  title: string;
  summary: string;              // one-liner for the picker card
  prompt: string;               // the exact user request, verbatim from the historical run
  repos: { sourcePath: string; pinnedCommit: string; stripGlobs: string[] }[];
  checklist: ChecklistItem[];
  tags: string[];               // "cross-stack" | "frontend" | "trap" | ...
  builtIn: boolean;
}

export const DEFAULT_TASKS: BenchTask[] = [ /* T1..T5, authored in Phase 1 */ ];
```

Custom tasks: same shape, stored as `DATA_DIR/bench/tasks/<id>.json`
(`lib/bench-task-store.ts`, CRUD mirroring `bench-store.ts`). Checklist optional for
custom tasks — without one, judging falls back to today's 5-criterion rubric.

### `lib/bench-types.ts`

- `BenchConfig` gains `taskId?: string` and `checklist?: ChecklistItem[]` (denormalized
  into the run so a later task edit can't change how an old run was judged).
- `JudgeScore` gains `checklist?: { itemId: string; verdict: "yes" | "no" | "unknown" }[]`
  and `checklistScore?: number` (points earned / max positive points, penalties applied).
- `BenchSummaryRow` gains `checklistScore?: number` and `worstRep?: number` (pass^k idea).

### `lib/bench.ts` — judging upgrades

1. **Checklist grading** (when the run has a checklist): per candidate, one extra judge
   call per pass: system prompt = "verify each checklist item against the candidate
   plan AND the real code in the working directory; answer yes/no/unknown per item,
   JSON only". One call per candidate (not per leaf like PaperBench — 5 tasks × ~15
   items makes per-leaf calls prohibitive on CLI latency; per-candidate is still narrow
   and cites the code). `checklistScore = (Σ points of "yes" positive items + Σ points
   of "yes" negative items) / Σ positive points`, clamped to [0,1], shown as 0–100.
2. **Existing rubric stays** as the secondary/comparability score, and as the only
   score for checklist-less custom tasks. Composite column = checklist score when
   available, rubric composite otherwise (labeled which).
3. **Dual-family judge option**: `judges: ModelRef[]` (1–2). With 2 (default for
   built-in tasks: claude-opus + codex default), each pass runs both and averages;
   per-judge scores kept in `JudgePass` so family disagreement is visible. Mitigates
   self-enhancement bias — our contenders are Claude+Codex, so a Claude-only judge is
   structurally suspect. (Config stays backward-compatible: `judge` upgrades to `judges`.)
4. **Verbosity guard**: one line added to `JUDGE_SYS`: "Longer is not better; reward
   the shortest plan that fully covers the request."
5. **Stats**: with reps ≥ 2, `summarize()` adds `worstRep` and, when exactly two
   contenders share the task set, a paired mean difference line. (Full SEM machinery
   is overkill at n≤3; spread + worst-rep is honest.)

### Snapshot plumbing

- `lib/bench-snapshots.ts` (server): `ensureSnapshot(task)` (clone/checkout/strip if
  missing, else validate commit), `resetSnapshot(task)` (checkout+clean),
  `snapshotWorkdir(task)` (the composite dir handed to contenders — for cross-stack
  tasks a parent dir containing both repo clones, mimicking migma-both's layout).
- `app/api/bench/tasks/route.ts` — GET list (built-in + custom), POST create custom.
- `app/api/bench/tasks/[id]/route.ts` — GET/PUT/DELETE custom task.
- `app/api/bench/tasks/[id]/snapshot/route.ts` — POST prepare snapshot (long-ish: clone
  is local-disk, seconds not minutes; runs inline), GET status `{ready, commit, path}`.
- `runBenchJob` calls `resetSnapshot` before each contender and before judging when
  `config.taskId` is set.

### `app/benchmarks/page.tsx` — form changes

- New **"Task"** section above the prompt box: preset cards (title, target tags,
  checklist size, snapshot status chip) + a **Custom** card.
  - Picking a preset: fills prompt (read-only), workdir = snapshot path (auto-prepares
    via the snapshot API with a spinner), shows the checklist collapsed for review.
  - Custom: today's free-form prompt + workdir, plus optional checklist editor
    (add row: text / points / axis) and "Save as task" so a good custom task graduates
    into the library.
- Dirty-workdir warning: when a custom workdir is a git repo with uncommitted changes
  or matches litter globs, show the "not reproducible" note (server does the check via
  a small `GET /api/bench/workdir-check?path=…` helper; no blocking, just honesty).
- Judge section: second judge row with an "add judge (recommended: different family)"
  affordance; results table shows per-judge composites on hover/expand.

## Task authoring process (Phase 1 — the actual "studies" work)

For each of T1–T5, a one-time authoring pass done in this repo with Claude Code:

1. Recover the verbatim historical prompt (from the `fuse-plan-*.md` header/filename
   and conversation history).
2. `git log` in the target repo(s) to find the last commit **before** the feature
   landed → `pinnedCommit`. Verify the request is *unimplemented* at that commit.
3. Study the shipped diff (the gold answer) and write the checklist: 8–20 items,
   each passing the "two experts would independently agree" bar, each anchored to a
   real path/symbol at the pinned commit; 2–5 negative-point fabrication items per
   task (for T5, mostly negative items).
4. **Calibrate once** (principle 8): run one Fast-mode contender on the task, judge it,
   then hand-check every checklist verdict. Reword items where the judge and a human
   would disagree. Only then mark the task `builtIn`.

## Implementation order

1. **Task authoring** — T1–T5 definitions in `lib/bench-tasks.ts` with checklists and
   pinned commits (process above). This is most of the value and has no code risk.
2. **Snapshots** — `lib/bench-snapshots.ts` + `scripts/bench-snapshot.sh` + task API
   routes; wire `resetSnapshot` into `runBenchJob`.
3. **Judging upgrades** — checklist grading, `judges[]` dual-family option, verbosity
   line, worst-rep in summary.
4. **UI** — task picker, checklist editor, dirty-workdir warning, per-judge display.
5. **Validation** — typecheck + build; calibration runs (step 4 of authoring) for all
   five tasks; then the first full suite run: Fast vs Relay vs Recon vs solo-sonnet vs
   solo-codex across T1–T5, reps=2. Review headroom: replace any task where all five
   contenders land within spread.

## Risks & mitigations

- **Pinned commits may be hard to isolate** (features landed in big mixed commits like
  `57332c2`). Mitigation: the pin only needs the feature to be *absent*, not a clean
  boundary — any earlier commit works; note in the task summary what else is missing at
  that commit if it affects the request's wording.
- **Snapshot divergence from reality** — a task pinned in July gets stale as migma
  evolves. Acceptable by design (comparability > freshness); revisit the suite
  quarterly, and the custom-task path covers "test on today's code" needs.
- **Checklist leakage into prompts.** Checklists live server-side and in run JSONs;
  they are never included in contender prompts, only judge prompts. Keep it that way —
  add a test asserting the contender message contains no checklist text.
- **CLI judge latency doubles with dual judges.** Judge calls are minutes, not hours;
  two judges × 3 passes ≈ 6 judge calls per run — acceptable. If it hurts, drop
  default passes to 2 when dual-judge is on (bias-variance tradeoff favors the second
  family over the third pass, per MT-Bench findings).
- **`git clean -fd` in resetSnapshot is destructive.** It only ever runs inside
  `DATA_DIR/bench/snapshots/` — `resetSnapshot` must assert the path is under the
  snapshots root before touching git, and refuse otherwise (never runs on a user's
  live folder or custom workdir).

## Testing

- Snapshot unit path: `ensureSnapshot` on a scratch git repo fixture → clone exists at
  pinned commit, litter stripped; `resetSnapshot` after dropping a stray file restores
  a clean tree; `resetSnapshot` on a path outside the snapshots root throws.
- Checklist scoring: feed `parseJudgeChecklist` fixtures (all-yes, mixed, unknown,
  malformed JSON) → expected scores, penalties applied, clamped at 0.
- Judge-prompt hygiene: assert built contender messages for a task run contain no
  checklist item text.
- Config migration: old run JSONs with `judge` (singular) still load and render.
- End-to-end: one calibration run per task (authoring step 4), then the full suite run
  described in step 5, verifying reset-between-contenders leaves no `fuse-plan-*.md`
  from contender A visible to contender B (check snapshot dir between contenders).
