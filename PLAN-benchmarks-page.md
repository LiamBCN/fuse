# PLAN: Benchmarks page — measure modes vs. solo models on the same task

## Goal

A first-class **Benchmarks** page (in the navbar) that runs a controlled experiment:
take one task, run it through any selection of **Fuse modes** (fast / relay / recon)
and any selection of **solo models** ("what would the result be if we used this model
alone?"), then score every output the same way and show a comparison table.

This productizes what `scripts/bench-plan-modes.sh` + `scripts/bench/extract-result.py`
do by hand today, and adds the two things they lack: **solo baselines** and
**automated blind judging** so results are comparable and repeatable.

## What "reliable and accurate" means here (methodology)

The design decisions below are the substance of this plan; the code is mostly plumbing.

1. **Same task, same contract.** Every contender (mode or solo model) gets the exact
   same prompt and workdir. Solo models get a single-pass system prompt that demands
   the *same deliverable shape* as the modes (the `## Goal / ## Affected files / …`
   plan contract from `lib/plan.ts`), so the judge compares plans against plans, not
   plans against chatty answers.
2. **Sequential execution.** Contenders run one at a time, never in parallel with each
   other. The modes already fan out 2 CLI agents internally; running two contenders at
   once would skew wall-clock timings and starve CPU/network. Elapsed time is only
   meaningful if each contender gets the machine to itself.
3. **Blind, multi-pass judging.** Outputs are anonymized (Candidate A/B/C…), the
   order is shuffled per pass, and the judge scores a fixed rubric. Default 3 judge
   passes; report mean and spread per criterion. High spread = low-confidence result,
   and we show that instead of hiding it.
4. **Grounded judging.** When the task has a workdir, the judge runs as a `claude-cli`
   call *with read access to that workdir* so it can fact-check claimed paths/symbols
   against real code — same fabrication-check approach as the 3-mode benchmark that
   picked the current mode lineup.
5. **Objective metrics alongside scores.** Wall time, total tokens, per-agent usage,
   output length, and error/clarify events are recorded raw. The judge never sees them
   (quality scores stay quality-only); the table shows both.
6. **No interactive escape hatch.** Benchmark runs append a line to the user prompt:
   *"Do not ask clarifying questions; make reasonable assumptions and state them."*
   A contender that still returns `@@CLARIFY@@` is recorded as `clarified` (a failure
   mode worth seeing, not a crash).

### Rubric (0–10 each, judged blind)

| Criterion | What the judge checks |
|---|---|
| Groundedness | Paths/symbols/signatures cited exist in the repo (judge verifies with Read/Grep) |
| Requirement coverage | Every requirement in the request is covered or explicitly descoped |
| Actionability | Steps concrete enough to execute without re-deriving the design |
| Testing quality | Testing steps satisfiable by the plan + current code (the QA_NOTE rule) |
| Clarity & scope | Well-organized, proportional, no invented scope |

Composite = mean of criteria (equal weights v1; weights can come later).

## Architecture

```
app/benchmarks/page.tsx          new run form + run list + live run detail
        │  POST /api/bench       start (returns {id} immediately)
        │  GET  /api/bench       list runs (summaries)
        │  GET  /api/bench/[id]  poll full run state (page polls ~2s while running)
        │  POST /api/bench/[id]/stop
        ▼
app/api/bench/*                  thin routes
        ▼
lib/bench.ts (server)            detached runner: contenders → judging → summary
        │ reuses runPlan / runMoa / callModel, registerRun for Stop
        ▼
lib/bench-store.ts (server)      JSON persistence in DATA_DIR/bench/<id>.json
lib/bench-types.ts (shared)      client-safe types (like lib/types.ts)
```

**Detached, not SSE.** Unlike `/api/chat`, a benchmark can run 1–2 hours (each recon
run alone was ~30+ min in the last bench). Tying it to an open SSE response means
navigation kills it. Instead `POST /api/bench` kicks off an async job in a
module-singleton registry (same `globalThis` pattern as `lib/run-control.ts`), which
persists progress to the store after every state change; the page polls `GET`. Reload,
navigate away, come back — the run keeps going. This matches the existing
module-singleton background-runtime approach used for concurrent chats.

## New files

### `lib/bench-types.ts` (shared, no server imports)

```ts
export type ContenderSpec =
  | { kind: "mode"; mode: Mode; proposers: ModelRef[]; aggregator: ModelRef; stageModels?: StageModelMap }
  | { kind: "solo"; model: ModelRef };

export interface BenchConfig {
  prompt: string;
  workdir?: string;          // empty = chat-style task (runMoa path)
  contenders: ContenderSpec[];
  judge: ModelRef;           // default { provider: "claude-cli", model: "claude-opus-4-8" }
  judgePasses: number;       // default 3
  reps: number;              // runs per contender, default 1
}

export type ContenderStatus = "pending" | "running" | "done" | "error" | "clarified" | "stopped";

export interface ContenderResult {
  spec: ContenderSpec;
  rep: number;
  status: ContenderStatus;
  final?: string;
  error?: string;
  elapsedMs?: number;
  usage?: Usage;             // summed, same shape the chat route computes
  usageItems?: UsageItem[];  // per-agent breakdown
}

export interface JudgePass {
  pass: number;
  order: number[];           // shuffled contender-result indices, for auditability
  scores: { resultIndex: number; criteria: Record<string, number>; composite: number; rationale: string }[];
  error?: string;
}

export interface BenchRun {
  id: string;
  createdAt: number;
  status: "running" | "judging" | "done" | "error" | "stopped";
  config: BenchConfig;
  results: ContenderResult[];
  judgePasses: JudgePass[];
  summary?: { resultIndex: number; composite: number; spread: number; perCriterion: Record<string, number> }[];
  error?: string;
}
```

### `lib/bench-store.ts`

Mirror of the `lib/db.ts` pattern: `DATA_DIR/bench/<id>.json`, with
`listBenchRuns(): Promise<BenchRunSummary[]>` (id, createdAt, status, prompt excerpt,
contender labels — read cheaply, don't load full outputs), `readBenchRun(id)`,
`writeBenchRun(run)` (atomic tmp+rename like the conversation store), `deleteBenchRun(id)`.

### `lib/bench.ts` — the runner

```ts
export function startBenchRun(config: BenchConfig): string  // creates run, fires async job, returns id
export function stopBenchRun(id: string): boolean           // aborts via its AbortController
```

Job loop:

1. **Contender phase** — for each contender × rep, sequentially:
   - `kind: "mode"` + workdir → `runPlan(messages, spec.proposers, spec.aggregator, spec.mode, workdir, …, ac.signal)`
   - `kind: "mode"` without workdir → `runMoa(...)` (mode label is fast-only in this case; see UI note)
   - `kind: "solo"` → one `callModel({ provider, model, messages: [soloSystem, user], workdir, signal })`
     with `SOLO_PLAN_SYS` (new const in `lib/bench.ts`, cloned from `DRAFT_SYS`'s output
     contract + `QA_NOTE` + `REQUIREMENT_COVERAGE_NOTE`, minus the `@@CLARIFY@@` escape)
     when workdir is set, or a plain "answer the request" system prompt when not.
   - Messages: `[{ role: "user", content: config.prompt + NO_CLARIFY_NOTE }]`.
   - Wrap each in try/catch: `AgentFailedError` → `status: "error"` for that result and
     **continue to the next contender** (one contender failing must not kill the
     comparison); `RunStoppedError` / aborted → mark rest `stopped`, run `stopped`, end.
   - `@@CLARIFY@@` in output (or `needsClarification` from `runPlan`) → `status: "clarified"`, excluded from judging.
   - Persist the run JSON after every contender so polling shows live per-contender status.
   - Append `usageItems` to the global usage log via `appendUsage` with
     `conversationId: "bench:" + id` so Stats stays truthful about spend.
2. **Judge phase** (`status: "judging"`) — for `pass in 1..judgePasses`:
   - Shuffle successful results; build one prompt: original request + rubric +
     `### Candidate A/B/C` blocks (no provider/model/mode names anywhere).
   - Judge call: `callModel({ ...config.judge, workdir: config.workdir, signal })` with a
     judge system prompt requiring **JSON-only** output:
     `[{ "candidate": "A", "scores": { groundedness: n, … }, "rationale": "…" }]`,
     and (when workdir) instructions to verify a sample of cited paths/symbols before scoring groundedness.
   - Parse defensively (extract first JSON array; on parse failure record `JudgePass.error` and move on).
3. **Summary** — per result: mean composite across passes, per-criterion means, and
   spread (max−min of composite across passes). Sort by composite. `status: "done"`.

Registration with `registerRun("bench:" + id, ac)` so the existing stop machinery
(`stopRuns`) works unchanged.

### API routes

- `app/api/bench/route.ts` — `POST` validates config (≥2 contenders, ≥1, prompt non-empty,
  judge set), calls `startBenchRun`, returns `{ id }`. `GET` returns `listBenchRuns()`.
- `app/api/bench/[id]/route.ts` — `GET` full run; `DELETE` removes a finished run.
- `app/api/bench/[id]/stop/route.ts` — `POST` → `stopBenchRun(id)` (mirrors `app/api/chat/stop`).
- All `runtime = "nodejs"`.

### `app/benchmarks/page.tsx` (+ `components/BenchRunView.tsx` if it gets big)

**New-run form**
- Prompt textarea, with a "load saved prompt" affordance later (v1: textarea only).
- Workdir: dropdown of `recentFolders` from settings + free text; blank = chat task.
- **Contenders — modes:** checkboxes for Fast / Relay / Recon (reusing `ModeBadge`
  styling). Each uses the current Settings proposers/aggregator/stageModels, shown
  read-only beneath the checkbox so the run config is explicit. Mode checkboxes are
  disabled without a workdir (modes are plan pipelines; note explains why).
- **Contenders — solo models:** rows of provider select (`PROVIDERS`) + model select
  (`defaultModels`) + free-text model, add/remove row. Preseed two rows from the
  current Settings proposers — that directly answers "how would each of my agents do alone".
- Judge model select (default claude-cli / claude-opus-4-8), judge passes (1–5), reps (1–3).
- Start disabled until ≥2 contenders. On start → navigate to the run view.

**Run list** — past runs from `GET /api/bench`, newest first, status pill, click to open.

**Run detail** (poll `GET /api/bench/[id]` every ~2s while `running`/`judging`)
- Per-contender row: label (ModeBadge for modes, `provider/model · solo` for solos),
  status chip, live elapsed, tokens when done.
- Stop button while running (calls the stop route; mirrors chat's Stop UX).
- When done: **results table** ranked by composite — score (with ± spread), per-criterion
  columns, time, tokens; winner row highlighted.
- Expandable per contender: full output rendered via `components/Markdown.tsx`,
  per-agent usage breakdown, judge rationales per pass.
- "Clarified"/"error" contenders shown greyed with the reason, excluded from ranking.

### Navbar

`components/Nav.tsx` — add `{ href: "/benchmarks", label: "Benchmarks" }` to `LINKS`
(between Stats and Settings).

## Existing-code touchpoints (small)

- `lib/plan.ts` — export `QA_NOTE` and `REQUIREMENT_COVERAGE_NOTE` (currently module-private)
  so the solo prompt reuses them verbatim instead of drifting copies. No behavior change.
- `scripts/bench-plan-modes.sh` — leave as-is for now (it exercises the real `/api/chat`
  path, which is a different guarantee). Add a comment pointing at `/api/bench` for
  judged comparisons. Optional later: a `bench-via-api.sh` that POSTs to `/api/bench`.

## Implementation order

1. **Types + store** — `lib/bench-types.ts`, `lib/bench-store.ts`. (small)
2. **Runner** — `lib/bench.ts`: contender phase only; judge phase stubbed to skip.
   Verify with `curl` against the three API routes (build them in this step too).
3. **Judging + summary** — judge prompt, JSON parsing, multi-pass aggregation.
4. **UI** — page, form, run list, run detail with polling; Nav link.
5. **Validation pass** — typecheck + `next build`; then one real smoke benchmark
   (fast mode vs. solo sonnet vs. solo codex on the migma prompt from
   `scripts/bench/prompt-migma.txt`) and sanity-check the table.

## Risks & mitigations

- **Long runs vs. dev-server restarts.** The detached job dies if the Next server
  restarts; the run JSON stays `running` forever. Mitigation: on `readBenchRun`/list, if
  a run is `running` but its id isn't in the in-memory registry, surface it as
  `stopped` ("server restarted"). Cheap and honest.
- **Judge self-preference bias.** A Claude judge may favor Claude-flavored prose.
  Blinding + rubric anchoring reduces but doesn't remove this. v1 ships with it
  documented in the UI (small footnote); v2 option: second judge model, average.
- **Plan-file litter in the workdir.** Modes write plan.md files (and `FILE_NOTE`
  permits scratch files) per contender. Acceptable — files are uniquely named and the
  bench records `planPath`s. Documented on the form under the workdir field.
- **Codex usage reporting.** If `codex-cli` returns thin usage data, token columns show
  what we get; time and quality scores don't depend on it.
- **Sequential = slow.** 3 modes + 2 solos × 1 rep on a recon-heavy config can take
  hours. The form shows a rough time estimate (contenders × recent per-mode averages,
  hardcoded heuristics v1) so the user knows before starting.

## Testing

- Store round-trip: unit-style check via a scratch script — write/read/list/delete a `BenchRun`.
- Runner without CLIs: fake contender via a solo spec pointing at a bad model name →
  expect `status: "error"` on that result and the run continuing to completion.
- Clarify path: prompt engineered to trigger `@@CLARIFY@@` in a mode contender →
  expect `clarified`, excluded from judging, run still completes.
- Stop: start a run, `POST /api/bench/<id>/stop` → remaining contenders `stopped`, run `stopped`.
- Judge parsing: feed the parser a judge reply with prose around the JSON array → still parses; garbage → `JudgePass.error` recorded, other passes still aggregate.
- End-to-end smoke (step 5 above): fast + 2 solos on prompt-migma.txt against the live
  server; verify table renders, usage rows appear in Stats under `bench:<id>`.
