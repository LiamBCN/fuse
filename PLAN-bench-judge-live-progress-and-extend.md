# Plan: Benchmark Judging — Live Progress, Extending Finished Runs, Git-Shared Results, Portable Task Suite

## Goal

Five changes to the Benchmarks feature:

1. **Explain & fix the "stuck on Judging · 0/3 finished" symptom.** Judging is not deadlocked — it is a long, fully sequential, completely invisible phase, and the history-card counter is stale by design. Fix both. *(Confirmed: the run in question finished on its own ~30 min later and the results render correctly — there is no functional judging bug. The stale `0/3` counter is the only real defect; everything else in this area is progress visibility.)*
2. **Real-time judging progress**, mirroring the Contenders section: one live row per judge pass with a pulsing status chip, ticking elapsed time, tokens, and a call-level progress readout ("rubric done · checklist 2/3").
3. **Extend a finished benchmark** with new contenders (modes or solo models) that reuses the already-produced outputs and judge verdicts — no re-running (and no re-paying for) contenders that already completed.
4. **Publish benchmark results to git.** Finished runs shouldn't live only in the app's data dir on one machine — they get exported into the Fuse repo (`bench/results/`) and committed/pushed, and runs committed by others show up in everyone's History.
5. **Two-task suite with a portable Fuse task.** The task picker shows exactly two tasks: the current default (Author Location Fields) and a task on the **Fuse repo itself** that anyone who has the app can snapshot from GitHub and run on their own device — no access to Migma's private repos required.

## Diagnosis (evidence from the actual stuck run)

Inspected the live run `8e422280-660a-4549-859b-f8491720ebde.json` in `~/Library/Application Support/Fuse/data/bench/` (default task `migma-author-location-fields`, judgePasses=2, reps=1, 3 contenders, judges `codex-cli/gpt-5.5` + `claude-cli/claude-sonnet-5`):

- All 3 contenders: `status: "done"` (finished ~11:39).
- Run status: `"judging"`, 4 judge-pass records present; passes 1×both judges and 2×gpt-5.5 fully scored; pass 2 × sonnet-5 was mid-flight (`scores: []`, no error). File kept updating (last write 12:12:53) while the Fuse app process (started 11:28) was still alive. **Judging was progressing normally — it is just slow and silent.**
- **Outcome confirmed:** the run subsequently completed on its own (~30 min of judging total) and the summary/results display fine. So the backend is correct; the deliverables here are progress UI, the stale-counter fix, and heartbeat persistence — not a bug fix in the judging pipeline itself.

### Why judging takes so long

Each judge pass is `1 rubric call + (1 checklist call × candidate)` — every one an agentic CLI session with repo access (`planMode` + `workdir`), see `judgeRun` in [lib/bench.ts:591-679](lib/bench.ts#L591). With the defaults:

```
2 passes × 2 judges × (1 rubric + 3 candidates) = 16 sequential CLI calls
```

At 2–10 minutes per call, judging routinely takes **30–90+ minutes** — longer than the contender phase itself (~17 min here) — with zero UI feedback beyond the pulsing "Judging" chip. `resetSnapshot` also runs before every one of those 16 calls ([lib/bench.ts:606,641](lib/bench.ts#L606)).

True hangs are already bounded: `lib/cli.ts` kills a CLI after 5 min of silence (`IDLE_TIMEOUT_MS`) and 60 min hard cap, and a failed pass is recorded as `judgePass.error` and the run continues — so the run *will* finish; the problem is perception + granularity, not a deadlock.

### Why the card says "0/3 finished" when all contenders are done

The history card renders `completedCount/resultCount` from `BenchRunSummary` ([app/benchmarks/page.tsx:1055](app/benchmarks/page.tsx#L1055)). But while a run is live, the page only re-fetches the **run detail** every 2 s; `refreshRuns()` (which rebuilds the summaries) is called **only on mount and when the run transitions to non-live** ([app/benchmarks/page.tsx:274-281](app/benchmarks/page.tsx#L274)). So the card keeps showing the counts captured at start time — `0/3` — for the entire run. The on-disk statuses are all `"done"`; this is purely a client staleness bug.

### Secondary observation (persistence granularity)

`judgeRun` persists only when a pass **starts** (after `judgePasses.push`, [lib/bench.ts:611](lib/bench.ts#L611)) and after the **entire pass including all checklist calls** finishes ([lib/bench.ts:676](lib/bench.ts#L676)). A healthy pass can therefore leave `updatedAt` untouched for 10+ minutes — indistinguishable from a wedged one, both for the UI and for anyone inspecting the JSON.

## Design

### 1. Judge-pass progress data model (`lib/bench-types.ts`)

Extend `JudgePass` (all fields optional so old persisted runs still parse):

```ts
export type JudgePassStatus = "pending" | "running" | "done" | "error" | "stopped";

export interface JudgePass {
  pass: number;
  judgeIndex?: number;
  judge?: ModelRef;
  order: number[];
  scores: JudgeScore[];
  error?: string;
  usage?: Usage;
  // NEW
  status?: JudgePassStatus;
  startedAt?: number;
  endedAt?: number;
  step?: "rubric" | "checklist";   // what the pass is doing right now
  checklistDone?: number;          // candidates whose checklist call finished
  checklistTotal?: number;         // candidates to checklist-verify this pass
}
```

Add derived judge-progress fields to `BenchRunSummary` so history cards can show it:
`judgeCallsDone?: number; judgeCallsTotal?: number;`.

### 2. `judgeRun` changes (`lib/bench.ts`)

- **Pre-create the full roadmap.** When judging starts, push *all* `passes × judges` `JudgePass` rows up front with `status: "pending"`, `checklistTotal` set, then persist once. The UI immediately shows the whole queue ("4 passes · 16 calls") instead of rows appearing one by one.
- **Heartbeat persists.** Update + `persist(run)` at every transition: pass → `running` + `startedAt`; rubric call returns (`step: "checklist"`); **after each candidate's checklist call** (`checklistDone++`); pass end (`done`/`error` + `endedAt`). This is ~5 extra small file writes per pass — negligible — and makes `updatedAt` a real liveness signal.
- **Stop handling:** on `RunStoppedError`, mark the in-flight pass and remaining `pending` passes `"stopped"` before rethrowing (mirrors `markRestStopped` for contenders).
- Compute `judgeCallsDone/Total` in `summarize()` in [lib/bench-store.ts:67](lib/bench-store.ts#L67): total = `passes.length × 1 + Σ checklistTotal` (fall back to config-derived estimate for old runs); done = completed rubric + `checklistDone` sums.

Backward compatibility for old runs: treat `status === undefined` as `done` when `scores.length || error`, else `running` if the run is live, else `stopped`.

### 3. Judges section in the run detail (`app/benchmarks/page.tsx`)

New section between **Contenders** and **Outputs**, visually identical to Contenders rows:

```
Judges                                    5/16 calls · ~2 of 4 passes done
┌──────────────────────────────────────────────────────────────────────┐
│ Pass 1 · codex-cli/gpt-5.5      [Done]      6m 12s   48,112 tokens   │
│ Pass 1 · claude-cli/sonnet-5    [Done]      8m 03s   51,987 tokens   │
│ Pass 2 · codex-cli/gpt-5.5      [Done]      5m 40s   47,203 tokens   │
│ Pass 2 · claude-cli/sonnet-5    [Judging ●] 4m 21s — rubric done ·   │
│                                             checklist 1/3           │
└──────────────────────────────────────────────────────────────────────┘
```

- Reuse `StatusChip` (add mapping for `JudgePassStatus`), `fmtMs` with the ticking `now` state (already updates every 1 s while live), and `fmtNum(pass.usage?.total_tokens)`.
- Row label: `Pass {n} · {judge.provider}/{judge.model}`; sub-line shows `step` + `checklistDone/checklistTotal` while running, or the pass error when failed.
- Header shows aggregate `judgeCallsDone/judgeCallsTotal` and, while `status === "judging"`, an ETA hint ("each call is a full CLI session over the repo — typically 2–10 min").
- Render the section whenever `run.judgePasses.length > 0` or `status === "judging"` (skip for execute-mode runs, which have no judges).

### 4. Fix the stale history counter

In the live-polling effect ([app/benchmarks/page.tsx:274-281](app/benchmarks/page.tsx#L274)), also refresh the run list while live (every other 2 s tick is fine):

```ts
const t = setInterval(async () => {
  const next = await fetchRun(selectedId);
  refreshRuns().catch(() => {});          // keep cards in sync too
}, 2000);
```

Plus a safety net for runs left live with the page unselected: a separate interval that calls `refreshRuns()` every 5 s whenever `runs.some(r => isLive(r.status))`. The card line becomes accurate (`3/3 finished`) and can additionally show `judging 5/16` when `status === "judging"`.

### 5. Prevent "looks stuck" in the future

- The heartbeat persists (§2) mean `updatedAt` now moves at least once per judge call.
- UI stall banner: if `isLive(run.status)` and `now - run.updatedAt > 12 min` (idle timeout 5 min + slack), show an amber note on the run: "No progress for N min — a judge CLI call may be wedged; it will be killed by the idle timeout, or you can Stop the run." (No auto-kill from the client; `cli.ts` timeouts already own that.)
- Keep judging sequential for now: both judges share the same snapshot workdir and `resetSnapshot` mutates it between calls, so parallelizing passes would race. Note as future work: per-judge snapshot copies would allow running the 2 judges concurrently and halving wall-clock.

### 6. Extend a finished benchmark with new contenders

**Concept:** a completed (or stopped/errored) run gains an "Add contenders" panel. New contenders run through the exact same pipeline and are judged with **new** judge passes; existing contender outputs and their existing judge scores are reused untouched. Only available when `!isLive(run.status)` — i.e. "already benchmarked" runs, as requested.

#### API

`POST /api/bench/[id]/extend` → `{ contenders: ContenderSpec[] }` → `202 { id }`.
Guards: run exists; not live (`409` otherwise); contenders array valid & non-empty; total results ≤ some sane cap (e.g. 12).

#### Backend (`lib/bench.ts` — `extendBenchRun(id, contenders)`)

1. Read the run; re-resolve the task via `config.taskId`. If the task has repos, call `ensureSnapshot(task)` / `snapshotWorkdir(task)` — the snapshot may have been reset or deleted since the original run — and update `config.workdir` if the path changed. For custom workdirs, verify the path still exists (fail fast with a clear error).
2. Append the new specs to `config.contenders` and push new `ContenderResult`s (`status: "pending"`, one per rep, matching `config.reps`), each tagged `extension: true` (new optional field on `ContenderResult`) so the UI can badge them "added later".
3. Clear `run.summary` (it is recomputed at the end; old judge passes stay), set `status: "running"`, `registerRun('bench:' + id)`, persist, and kick off the existing `runBenchJob` loop **restricted to the new result indices** — refactor the `for (let i = 0; …)` loop body into `runOneContender(run, i, task, ac)` and have both the normal job and the extension job iterate their own index list. Existing stop/rate-limit/error semantics carry over unchanged.
4. **Judging the extension (the token saver):** call `judgeRun` with a new `onlyIndices` parameter = the new result indices.
   - Checklist calls (the expensive per-candidate part) run **only for new candidates**: `passes × judges × newCandidates` instead of `× allCandidates`.
   - The rubric call includes **all** candidates' outputs in the prompt (old outputs come from disk — zero contender cost; the judge prompt is marginally bigger) so new candidates are scored blind *side-by-side with the incumbents*, preserving comparability. All candidates in the call get scored; that gives old candidates a few extra rubric data points, which `summarize()` merges harmlessly (for checklist-scored tasks the composite ignores rubric anyway; for rubric-only runs it just averages more samples per candidate).
   - New passes get a `pass` number continuing after the existing max, and the same progress fields from §2, so the Judges section shows the extension judging live too.
5. On completion: `run.summary = summarize(run)` (already merges scores across all passes by `resultIndex` and handles per-spec `worstRep`), `status: "done"`, persist.
6. **Execute-mode runs:** same flow but simpler — new contenders go through `runExecutionContender` and `summarizeExecution(run)` already recomputes over all results; no judging needed. (Requires the snapshot re-preparation from step 1 so the verifier has a clean tree.)

Scoring comparability note (documented in the UI tooltip): checklist scores — the headline for built-in tasks — are absolute per-candidate verdicts, so old and new scores are directly comparable. Rubric scores for new candidates are produced side-by-side with the old outputs in the same prompt, which keeps the relative calibration honest without re-paying for old checklist calls.

#### UI (`app/benchmarks/page.tsx`)

- In `RunDetail`, when `!isLive(run.status)`: an **"Add contenders"** collapsible under the Contenders section. Reuse the existing builder pieces from the start form: mode checkboxes (pre-unchecking modes already in the run, but duplicates allowed — they land as extra reps of that spec) + solo model rows (provider select + model input), and the same limit preflight warning (`preflightWarnings`) before starting.
- Submit → `POST /api/bench/[id]/extend` → the existing live-polling effect takes over automatically (status flips to `running`), and the fixed list refresh (§4) keeps the card correct.
- Extended result rows get a small "added {date}" badge via the `extension` flag; the comparison chart/table need no changes (they read `run.summary`).
- Disable Delete while extending (already blocked server-side by the live-status 409).

### 7. Publish benchmark results to git (shared, not device-only)

Today finished runs exist only as JSON in the app data dir (`~/Library/Application Support/Fuse/data/bench/*.json`). They should also land in the Fuse repo so results are versioned, reviewable in PRs, and visible to everyone who pulls.

#### Repo layout

```
bench/results/<taskId>/<yyyy-mm-dd>-<runId8>.json    # sanitized full run record
bench/results/<taskId>/<yyyy-mm-dd>-<runId8>.md      # human-readable summary (reuses the existing AI-export markdown builder, page.tsx ~1435)
bench/results/index.json                             # tiny manifest: id, taskId, date, contenders, best, scores (for fast listing)
```

#### Export pipeline (`lib/bench-publish.ts`, new)

- `publishBenchRun(run)`:
  1. Resolve the target repo root. New setting `benchResultsRepo` (Settings → Benchmarks): defaults to the Fuse checkout when running `next dev` (`process.cwd()`); the packaged Mac app has no repo, so the setting stores the user's local Fuse clone path (validated with `git rev-parse --show-toplevel`). If unset in the packaged app, the Publish button prompts for it once.
  2. **Sanitize** the run before writing: strip absolute machine paths (`config.workdir`, snapshot paths inside outputs get replaced with `<workdir>`), keep everything else (outputs, scores, judge passes, usage) — that's the shareable value.
  3. Write the JSON + markdown + update `index.json`, then `git add bench/results/... && git commit -m "bench: <taskTitle> — <best label> <score> (<runId8>)" && git push` — via `execFile("git", ...)` like `lib/bench-snapshots.ts` does. Only these paths are staged; a dirty tree elsewhere is untouched.
  4. Failure handling: commit succeeded but push failed (no network/auth) → surface "committed locally, push failed: <reason>" and leave it; re-publish is idempotent (same path, `git status` no-op detection).
- **Trigger:** a **"Publish to git"** button on every finished run (detail view + history row action), plus an **auto-publish toggle** in Settings (default on for dev, off for packaged until `benchResultsRepo` is set). Auto-publish fires from `runBenchJob` right after `status: "done"` persists; failures never affect the run itself (best-effort, logged on the run as `publishError`).
- Track publish state on the run: `published?: { at: number; commit: string; path: string }` so the button shows "Published ✓ abc1234" and re-publishing updates in place.

#### Import: shared results show up in History

- `listBenchRuns()` additionally scans `<benchResultsRepo>/bench/results/**.json`, parses them as `BenchRun`s, and merges with local runs — **deduped by id, local copy wins** (it has live status). Merged entries get `shared: true` on their `BenchRunSummary` and render with a small "from git" badge; they are read-only (no Delete — Delete only removes local runs; removing a shared result means deleting the file in git).
- The run detail view works unchanged on shared runs (it's the same shape); Extend (§6) also works on them — extending a shared run first copies it into the local data dir as a new local run that references the original (`extendedFrom: <id>`).

### 8. Task suite: exactly two tasks, second one on the Fuse repo itself

#### Trim the picker to two

In [lib/bench-tasks.ts](lib/bench-tasks.ts): `DEFAULT_TASKS` becomes exactly:
1. `migma-author-location-fields` — unchanged, stays the default (`DEFAULT_BENCH_TASK_ID`).
2. A Fuse-repo task — **promote the existing hidden `fuse-mode-badges-live-run`** from `ADDITIONAL_BENCH_TASKS` (it already has a solid 12-item checklist and pins Fuse commit `14d9ab2`, which is on `origin/main`, so it's fetchable by anyone).

`migma-admin-panel-rbac` and `migma-blog-dates` move down into `ADDITIONAL_BENCH_TASKS` (kept in code, hidden from the picker, per the existing convention at [lib/bench-tasks.ts:369](lib/bench-tasks.ts#L369)).

#### Make the Fuse task portable (runs on anyone's device)

Problem: `BenchTaskRepo.sourcePath` is a machine-local absolute path (`/Users/liam/projects/fuse`) and `createSnapshotRepo` does `git clone --local <sourcePath>` ([lib/bench-snapshots.ts:117-121](lib/bench-snapshots.ts#L117)). On any other machine the clone fails. The Migma tasks can stay local-only (private repos), but the Fuse task must not.

- Extend the repo spec: `interface BenchTaskRepo { sourcePath?: string; gitUrl?: string; dirName?: string; pinnedCommit: string; stripGlobs: string[] }`.
  - Fuse task repo: `{ gitUrl: "https://github.com/LiamBCN/fuse.git", sourcePath: FUSE_REPO, dirName: "fuse", pinnedCommit: FUSE_MODE_BADGES_BASE, ... }`.
- `createSnapshotRepo` resolution order: `sourcePath` exists locally → `clone --local` (fast, offline, Liam's path); otherwise `gitUrl` → `git clone --filter=blob:none <gitUrl>` then `checkout --detach <pinnedCommit>` (blobless clone keeps it small but still lets detach materialize the tree). Neither available → clear error naming what's missing.
- `repoDir` currently derives the folder name from `path.basename(sourcePath)` ([lib/bench-snapshots.ts:67-71](lib/bench-snapshots.ts#L67)) — use `dirName ?? basename(sourcePath ?? gitUrl)` so URL-cloned repos get stable names.
- Task picker UX for unavailable tasks: `getSnapshotStatus`/`ensureSnapshot` errors already surface per-task in the UI; add a friendlier message for Migma tasks on machines without the source paths ("requires local access to the Migma repos") so other users understand why only the Fuse task is runnable for them.
- Pinned-commit rule going forward: any commit referenced by a shareable task **must be pushed to `origin/main`** before shipping the task (verify with `git branch -r --contains <sha>`; add this check to `ensureSnapshot`'s gitUrl path error message).
- The Fuse task's prompt/checklist are already written against `14d9ab2`; re-validate the checklist still matches that tree (it was authored for it) and optionally re-pin to a newer pushed commit if we prefer benchmarking against current Fuse — either is fine, but pin + checklist must move together.

## File-by-file changes

| File | Change |
|---|---|
| `lib/bench-types.ts` | `JudgePassStatus`, new `JudgePass` progress fields, `ContenderResult.extension?`, `BenchRunSummary.judgeCallsDone/Total`, `BenchRun.published?`, `BenchRunSummary.shared?` |
| `lib/bench.ts` | `judgeRun`: pre-create passes, heartbeat persists, stop marking, `onlyIndices` param, checklist-only-for-new logic; extract `runOneContender`; new `extendBenchRun`; auto-publish hook after `done` |
| `lib/bench-store.ts` | `summarize()`: compute `judgeCallsDone/Total`; `surfaceStaleRun`: also mark in-flight judge passes `stopped` on restart; `listBenchRuns()` merges git-shared results (dedupe by id, local wins) |
| `lib/bench-publish.ts` | **new** — sanitize + write to `bench/results/` + `git add/commit/push`; `benchResultsRepo` resolution |
| `lib/bench-tasks.ts` | `BenchTaskRepo` gains `gitUrl`/`dirName`, `sourcePath` optional; `DEFAULT_TASKS` = [author-location, fuse-mode-badges-live-run]; RBAC + blog-dates tasks demoted to `ADDITIONAL_BENCH_TASKS` |
| `lib/bench-snapshots.ts` | `createSnapshotRepo`: local-path → gitUrl fallback (`clone --filter=blob:none` + detach); `repoDir` uses `dirName`; clearer unavailable-task errors |
| `lib/settings.ts` / `app/settings/page.tsx` / `app/api/settings/route.ts` | new `benchResultsRepo` path + `benchAutoPublish` toggle |
| `app/api/bench/[id]/extend/route.ts` | **new** — POST handler with guards |
| `app/api/bench/[id]/publish/route.ts` | **new** — POST triggers `publishBenchRun`, returns commit info / error |
| `app/benchmarks/page.tsx` | Judges live section; poll-time `refreshRuns()`; stall banner; card shows `judging x/y calls`; Add-contenders panel; "added later" badge; Publish button + "Published ✓ <sha>" state; "from git" badge on shared runs |
| `lib/plan.test.ts` (or new `lib/bench.test.ts`) | unit tests below |

## Testing

Unit (pure functions, no CLI):
- `summarize()` merges old + extension judge passes: composites per candidate correct when old scores have `checklistScore` and extension rubric re-scores old candidates (checklist source must win; no double counting).
- Judge-call progress math: `judgeCallsTotal/Done` for fresh runs, legacy runs (no new fields), and extended runs.
- Legacy-run tolerance: `JudgePass` without `status` renders as done/stopped correctly.
- `extendBenchRun` guards: live run rejected; results appended with correct reps + `extension` flag; `config.contenders` updated.
- Publish sanitizer: absolute workdir/snapshot paths replaced everywhere in the exported JSON (config + contender outputs + judge prompts stored in passes); re-publish is idempotent.
- `listBenchRuns()` merge: shared + local with same id → local wins; shared-only runs get `shared: true`; Delete refuses shared runs.
- Repo spec resolution: `sourcePath` present-and-exists → local clone; missing → `gitUrl`; neither → typed error.

Manual (dev server):
1. Run the default benchmark (passes 2, reps 1). During judging: Judges section shows 4 rows, statuses advance, checklist counter ticks, elapsed ticks, history card shows `3/3 finished · judging x/16 calls`.
2. Stop mid-judging → in-flight pass marked `stopped`, run `stopped`, no orphan CLI processes.
3. Restart the app mid-judging → run surfaces as stopped with judge passes marked stopped (not stuck at "judging").
4. On the finished run, add one solo contender → only 1 contender executes; judging runs `2 passes × 2 judges` with checklist only for the new candidate; summary re-ranks all 4; new row is badged.
5. Old pre-change run JSONs still open and render.
6. Publish a finished run → `bench/results/<taskId>/…json+md` committed & pushed; button flips to "Published ✓ <sha>"; `git show` confirms no `/Users/liam/...` paths in the export. Pull on another checkout (or `git stash` + fresh clone) → the run appears in History with the "from git" badge and opens read-only.
7. Task picker shows exactly 2 tasks. Rename/move the local Fuse repo path temporarily (or test on another machine) → the Fuse task still prepares its snapshot by cloning `gitUrl` at `14d9ab2` and a full benchmark runs end-to-end; the Migma task shows the "requires local access to the Migma repos" notice instead of a raw git error.

## Out of scope / future work

- Parallelizing the two judges per pass (needs per-judge snapshot copies to avoid `resetSnapshot` races) — would roughly halve judging wall-clock.
- Per-call live token/activity streaming for judges (contenders don't have that either; both could get an `ActivityFn` feed later).
- Re-judging *old* candidates' checklists during an extension (deliberately skipped — that's the token cost the extension exists to avoid).
- Cross-machine result aggregation views (e.g. same task benchmarked on 3 devices → grouped leaderboard). The git-shared results make the data available; a grouped view can come later.
- Making the Migma tasks portable (would require publishing snapshot tarballs or granting repo access — deliberately not planned; they stay Liam-local).
