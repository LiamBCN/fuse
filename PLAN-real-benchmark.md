# PLAN: A Real Benchmark — Modes vs Solo Models, Execution-Verified

**Goal:** Replace "LLM judge liked this plan" with "the code actually worked" as Fuse's primary benchmark signal, using a minimal, near-zero-cost version of the same methodology OpenAI and Google use (SWE-bench Verified/Pro, Terminal-Bench 2.1), plus one in-house execution-verified task (migma author country).

**Cost constraint:** All agent work runs through the local Claude Code / Codex CLIs (subscription quota, no metered API). The only real costs are usage-limit burn and wall-clock time. Existing `fetchAllLimits()` delta tracking already measures the former.

---

## 1. Research: how OpenAI and Gemini benchmark new models

### What they report in launch posts (verified, mid-2026)

| Lab / model | Agentic coding | Math / reasoning |
|---|---|---|
| **OpenAI GPT-5.5** (Apr 2026) | Terminal-Bench 2.0 **82.7%** (headline number), SWE-bench Pro 58.6%, GDPval 84.9%, OSWorld 78.7%, internal "Expert-SWE" (~20h human tasks) | — |
| **OpenAI GPT-5.2** (Jan 2026) | SWE-bench Verified 80%, SWE-bench Pro 55.6% | AIME 2025 100%, GPQA Diamond 93.2%, ARC-AGI-2 52.9%, FrontierMath T1–3 40.3% |
| **Gemini 3.1 Pro** (Feb 2026) | SWE-bench Verified 80.6%, Terminal-Bench 2.0 68.5% *"under the Terminus-2 harness"* | GPQA 91.9%, HLE 37.5%, MathArena Apex, ARC-AGI-2 45.1% |

### How those benchmarks actually score

- **SWE-bench Verified** — 500 human-validated real GitHub issues (Python). Agent produces a patch; scoring is **fail-to-pass unit tests in Docker, pass@1**. No judges, no rubrics.
- **SWE-bench Pro** (Scale AI) — 1,865 long-horizon tasks (avg patch 107 LOC / 4.1 files), public + held-out commercial splits for contamination resistance. Same unit-test scoring. Frontier models score <20% on the commercial set.
- **Terminal-Bench 2.1** (Laude Institute) — **89 hand-crafted terminal tasks** (SWE, sysadmin, ML, data), one Docker env per task, **all pytest validations must pass — no partial credit**. 2.1 fixed ambiguous tasks and moved from turn limits to time limits. Runs on the Harbor harness with first-class **Claude Code and Codex CLI adapters** — it literally benchmarks the same CLIs Fuse wraps.
- **Math evals** (for context, since these are "solo model" only and mostly saturated): AIME (30 problems/yr, exact integer match), GPQA Diamond (198 MC), HLE (~2,500 Q), FrontierMath (~300, auto-verified answers). These don't exercise orchestration, so they're out of scope for testing Fuse modes.

### Methodology lessons we adopt

1. **Ground truth over judges.** Every headline coding number is unit-test-verified, pass@1. Judges (GDPval-style panels) are used only where no tests exist.
2. **The harness is a first-class variable.** On Terminal-Bench 2.1 the *same model* moves ~7 points across harnesses; Google now names the harness in its launch posts. This is exactly Fuse's thesis — modes *are* a harness — so it's the right benchmark family for us.
3. **Small official subsets are legitimate.** SWE-bench Verified **Mini** (50 stratified tasks, ~5 GB of images vs 130 GB — `MariusHobbhahn/swe-bench-verified-mini`, used by Princeton's HAL leaderboard) and `tb run --task-id` subsets are the standard cost-reduction moves.
4. **Statistics on small N** (Anthropic "Adding Error Bars to Evals", arXiv:2411.00640): SE ≈ √(p(1−p)/N). N=50 → ±~7pp at 95% CI; N=20 → ±~11pp. The fix for small N is **paired per-task comparison** (same tasks for every contender, compare per-task win/loss, McNemar-style) plus multiple attempts per task — not more contenders.

---

## 2. Design decisions

### D1 — Score executed code, not prose plans
Current bench (lib/bench.ts) judges plan Markdown with LLM rubrics/checklists. New benchmark: every contender must **produce working changes**, scored by deterministic verification (tests pass / task validations pass). LLM judging stays only as a secondary axis for the in-house task's "plan quality" and for the existing trap task.

### D2 — What a "mode" contender means in an execution benchmark
Fuse modes output plans. To make them executable contenders, each mode run becomes **plan → execute**:

- `mode+exec` contender = run the mode (fast/relay/recon) to produce a plan, then hand the plan to a **fixed executor** (one CLI, one model, `--permission-mode acceptEdits`-equivalent, workspace-write) with the instruction "implement exactly this plan."
- `solo` contender = the same executor model given the raw task directly (no plan stage).

This isolates the variable we actually sell: *does upstream multi-model planning make the final code better?* Executor model is held constant across all contenders in a run.

### D3 — Three tracks, in order of increasing effort

| Track | What | Tasks | Scoring | Why |
|---|---|---|---|---|
| **A. In-house (migma)** | Execution-verified version of the existing author-country task at /Users/liam/migma-both | 3–5 tasks | Deterministic verifier script (tests + greps + build) | Zero new infra concepts; reuses snapshots; our domain |
| **B. Terminal-Bench 2.1 subset** | `tb run` via Harbor with Claude Code / Codex adapters + a custom Fuse adapter | 10–15 of 89 | Built-in pytest validations, all-or-nothing | Industry-standard, purpose-built for CLI agents, Docker-on-Mac works |
| **C. SWE-bench Verified Mini (stretch)** | Generate patches locally, evaluate via **sb-cli** cloud (no local Docker/arm64 pain) | 10–25 of 50 | Official fail-to-pass tests, pass@1 | Direct comparability to lab-reported numbers |

Start with A (1–2 days), then B (2–3 days). C only if A+B show a signal worth publicizing, because SWE-bench tasks are Python-repo issues where the plan→execute split is least natural.

### D4 — Paired comparison + reps as the significance strategy
- Every contender runs **every task** (paired design).
- **2 attempts per task per contender** minimum (pass@1 averaged over attempts; also report "any-pass").
- Primary metric: **per-task win/loss/tie between mode+exec and solo** with a sign-test p-value, plus overall resolve-rate ±95% CI (Wilson interval).
- Secondary metrics (already tracked): wall-clock, tokens, usage-limit delta %, error/rate-limit counts.
- Rule of thumb from the error-bars paper: with 15 paired tasks × 2 attempts, we can detect a ~15–20pp true delta; that's the honest floor and the plan says so in the report template.

---

## 3. Track A — In-house execution benchmark (migma author-country)

Builds directly on the existing snapshot system (lib/bench-snapshots.ts) and the `migma-author-location-fields` task (lib/bench-tasks.ts).

### A1. Extend the task type with a verifier

```ts
// lib/bench-types.ts
export type BenchVerifier = {
  kind: "script";
  // path relative to repo root inside snapshot, or inline steps
  steps: VerifierStep[];        // run sequentially, all must pass
  timeoutMs: number;
};
export type VerifierStep =
  | { run: string; cwd?: string; expectExitZero: true }        // e.g. "npm test -- author"
  | { grep: string; file: string; expect: boolean };           // structural assertions
```

Task gains `verifier?: BenchVerifier` and `execution?: boolean`. Scoring: fraction of verifier steps passed → but **headline number is binary** (all steps pass = resolved), matching Terminal-Bench's no-partial-credit philosophy. Keep step-level results for diagnosis.

### A2. Verifier for author-country (the concrete first task)

Derived from PLAN-migma-author-location.md's checklist, as deterministic checks against the *modified snapshot*:

1. `grep` backend author type/validation for `country` and `city` (optional fields).
2. `grep` frontend author dialog for both inputs; public author page + JSON-LD for country render.
3. `run` backend test suite subset (`npm test -- author` or equivalent — confirm exact command against migma-backend).
4. `run` frontend `tsc --noEmit` and targeted vitest/jest if present; fall back to `next build` of the two touched routes if no tests exist.
5. Negative checks: `grep` that country is **not** required in validation schema; no new API endpoint files.

Write it once by hand, validate it by implementing the task manually in a scratch worktree and confirming the verifier flips from fail→pass.

### A3. Execution runner changes (lib/bench.ts)

1. New contender kind or flag: `{ kind: "mode", execute: true }` / `{ kind: "solo", execute: true }`.
2. For execute contenders:
   - `ensureSnapshot` + **fresh git worktree per attempt** (don't mutate the base snapshot; `git worktree add` from pinned commit — cheaper than reclone, perfectly isolated, parallel-safe later).
   - Mode contenders: `runPlan(...)` as today → then executor call: `callModel(executorProvider, executorModel, [EXEC_SYS, plan + task prompt], worktree, /*planMode*/ false, signal)` with write access and a turn/time budget (start: 40 turns / 20 min idle-based, reusing lib/cli.ts idle timeouts).
   - Solo contenders: executor call directly with the task prompt.
3. After execution: run verifier steps in the worktree, record `{ resolved: boolean, steps: StepResult[] }`, then `git diff --stat` captured for the run record.
4. Reset = delete worktree. Keep the diff patch file in `DATA_DIR/bench/<runId>/patches/` for inspection.

### A4. Task set for Track A (3–5 tasks)

Reuse the existing suite where a verifier is writable:

1. **migma-author-location-fields** (cross-stack) — verifier above.
2. **migma-blog-dates** (frontend only) — greps on article page/metadata/sitemap + `tsc --noEmit`.
3. **migma-author-email-team** (cross-stack) — greps + backend tests.
4. (Optional) **fuse-mode-badges-live-run** — vitest exists in this repo (lib/plan.test.ts pattern), most testable.
5. Keep **migma-draft-workflow-trap** as judge-scored only (fabrication resistance has no unit test).

### A5. Contender matrix for the first real run

Executor fixed at `claude-cli/sonnet` (mid-tier, so planning quality has room to matter):

| Contender | Stages |
|---|---|
| solo sonnet | executor only |
| solo fable | fable end-to-end (upper baseline) |
| fast + exec | fast(sonnet×2 → opus) → sonnet executor |
| recon + exec | recon → sonnet executor |

4 contenders × 4 tasks × 2 attempts = 32 executions + 8–12 plan-stage runs. At ~3–8 min each this is an overnight run, gated by usage limits — the runner must already handle `rateLimited` status (it does) and should **pause/resume on limit exhaustion** rather than fail the run (small addition: retry-after-reset loop using lib/limits.ts data).

---

## 4. Track B — Terminal-Bench 2.1 subset

### B1. Setup

```bash
uv tool install terminal-bench   # tb CLI; requires Docker Desktop (arm64 OK for tb)
tb run --dataset terminal-bench-core==2.1 --agent claude-code --task-id <task> 
```

- Verify the shipped **claude-code** and **codex** adapters work on this Mac with subscription auth (they drive the same CLIs Fuse resolves in lib/cli.ts). This alone gives **solo baselines on a real public benchmark for free**.
- Select a fixed subset of **12 tasks** spanning categories (SWE / sysadmin / data / ML), chosen once by listing the registry and sampling per category with a fixed seed; commit the task-id list to `scripts/bench/tb-subset.txt`. Never resample (that's how you accidentally p-hack).

### B2. Fuse adapter for Harbor

Harbor supports custom agent adapters (same mechanism as the OpenHands/mini-swe-agent adapters). Write a minimal adapter that:

1. Receives the task instruction + container context.
2. Calls Fuse's pipeline: either via `POST /api/chat` against a locally running Fuse (mode selected per env var), or — cleaner — a small headless entry point `scripts/bench/run-mode.ts` that imports `runPlan`/executor directly so no server is needed.
3. Plan stage runs read-only against the task's mounted workdir; executor stage applies changes inside the container; tb's own pytest validation scores it.

Risk: Harbor expects the agent to run *inside/against* the task container; the plan→execute split must both target the container filesystem. If the adapter API fights us, fallback is running only the **executor** through tb's claude-code adapter with the mode-generated plan prepended to the instruction — same measurement, much less glue.

### B3. Run matrix

Same 4 contenders as Track A × 12 tasks × 2 attempts = 96 tb runs. All-or-nothing pass, paired per-task comparison. tb records per-task logs; ingest results JSON into a BenchRun-shaped record so the existing app/benchmarks UI can display them (small importer: `scripts/bench/import-tb-results.ts`).

## 5. Track C (stretch) — SWE-bench Verified Mini via sb-cli

Only if Tracks A+B show modes ≥ solo. Recipe (avoids arm64 Docker entirely):

1. Dataset: `MariusHobbhahn/swe-bench-verified-mini` (50 tasks); take 10–25 by fixed seed.
2. For each instance: clone repo at base commit → run contender (mode plan → executor, or solo) in the checkout → `git diff` = prediction patch.
3. Evaluate: `sb-cli submit swe-bench_verified test --predictions_path preds.json --instance_ids <subset>` — cloud-side official scoring, no local images.
4. Report resolve-rate vs the published GPT-5.x / Gemini / Claude numbers *with the explicit caveat* that N≈25 → ±~13pp CI; the paired mode-vs-solo delta is the claim, not the absolute number.

---

## 6. Reporting

One results doc per campaign: `BENCH-RESULTS-<date>.md` generated by `scripts/bench/report.ts`:

- Headline table: contender × track → resolved %, ±95% Wilson CI, mean wall-clock, mean tokens, limit-burn %.
- **Paired table**: per task, which contenders resolved it; mode-vs-solo win/loss/tie + sign-test p.
- Attempt-level appendix with links to patches/logs.
- Honesty box: N, CI width, what deltas are/aren't detectable.

Also surface execution runs in the benchmarks page: `resolved` badge + step results replaces the composite score column when `scoreSource: "verifier"` (third scoreSource value).

---

## 7. Milestones

| # | Deliverable | Est. |
|---|---|---|
| M1 | Verifier types + worktree-per-attempt + executor stage in lib/bench.ts; author-country verifier passing on a hand-made solution | 1 day |
| M2 | Track A campaign (4 contenders × 4 tasks × 2 attempts) + report script | 1 day (mostly unattended runtime) |
| M3 | tb installed; solo claude-code/codex baselines on 12-task subset | 0.5 day |
| M4 | Fuse adapter (or plan-prepend fallback) + Track B campaign + importer | 1–2 days |
| M5 | Results doc; decide whether Track C is worth it | 0.5 day |

**Definition of "modes win":** on paired tasks across Tracks A+B (≈16 tasks × 2 attempts), mode+exec resolves strictly more tasks than solo-with-same-executor, sign-test p < 0.1, without exceeding 2× solo wall-clock or 2× limit burn. Anything weaker → iterate on modes (PLAN-two-mode-consolidation.md), not on the benchmark.

## 8. Open questions / risks

- **Limit burn**: 32 + 96 CLI runs in a campaign will eat real subscription quota. Mitigate: run overnight across limit-reset windows; the pause-on-rate-limit loop in A3 is required, not optional.
- **Executor contamination**: the executor model may "fix" a bad plan by ignoring it. Log `git diff` vs plan's Affected-files list; report plan-adherence as a diagnostic, not a score.
- **migma test coverage**: if migma-backend/front have thin test suites, verifiers lean on greps + tsc/build — weaker than real tests. Check actual test commands during M1 before committing to task list.
- **Harbor adapter API churn**: tb/Harbor is young; pin the tb version in the subset file and scripts.
