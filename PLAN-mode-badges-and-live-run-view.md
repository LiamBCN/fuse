# Plan: Mode badges in conversations/history + live expandable run diagram

Two features:

1. **Mode visibility** — every assistant reply records which mode (Normal / Fast / Deep) produced it, shown as a badge in the chat transcript, the History list, and the per-conversation Debug view. Today the mode lives only in the global `FuseConfig` and is guessed after the fact by regexing stage labels (`debugDump`, app/page.tsx:1017-1027).
2. **Live run view** — while a plan is generating, an **Expand** button on the progress block opens the same vertical diagram the Pipeline page uses (recon → drafts → verify → synthesize), but driven by the *real* run: each stage shows a spinner while running (with live streamed text for Claude stages), gets a ✓ when done, auto-collapses its reply, and moves focus to the next stage. Completed stages can be re-expanded to read that model's full reply mid-run; the whole view can be minimized back to the compact progress bar.

Interpretation note: "mark the completed steps" = stages are auto-marked ✓ as the pipeline completes them (with manual expand/collapse per stage). No user-driven checkbox state is persisted.

## Goal

- Persist `mode` on each assistant `Turn` so transcripts and history are self-describing (no more label-regex inference for new conversations; keep the heuristic only as a fallback for old ones).
- Stream structured per-stage state (`pending / running / done / error`, streamed chars, live text tail, final stage output) over the existing SSE channel, store it on the in-memory `RunRecord`, and render it as an interactive live diagram reusing the Pipeline page's visual language.

## Affected files

| File | Change |
|---|---|
| [lib/types.ts](lib/types.ts) | edit — add `mode?: Mode` to `Turn`; add new `StageInfo` / `StageKey` / `StageStatus` types |
| [lib/providers.ts](lib/providers.ts) | edit — extend `ActivityInfo` with optional `tail?: string` |
| [lib/cli.ts](lib/cli.ts) | edit — Claude path: accumulate delta text into a capped rolling tail and pass it to `onActivity` |
| [lib/plan.ts](lib/plan.ts) | edit — add `onStage` callback to `runPlan`; emit stage lifecycle events from every stage |
| [app/api/chat/route.ts](app/api/chat/route.ts) | edit — echo `mode` in the `result` event; forward stage events as `{type:"stage"}` SSE |
| [lib/chat-runtime.ts](lib/chat-runtime.ts) | edit — `mode` on `RunRecord`/`StartOpts`/`ResultEvent`; parse+merge `stage` events; write `mode` onto the persisted assistant turn |
| [components/flow.tsx](components/flow.tsx) | NEW — flow primitives (`Node`, `StepCard`, `PlanCard`, `Pair`, `Hero`, `Fan`, `Spine`, `Label`, icons) extracted from the pipeline page |
| [components/LiveRunView.tsx](components/LiveRunView.tsx) | NEW — the live diagram, driven by `mode` + `StageInfo[]` |
| [app/pipeline/page.tsx](app/pipeline/page.tsx) | edit — import the extracted primitives (pure refactor, no visual change) |
| [app/page.tsx](app/page.tsx) | edit — pass `mode` to `startRun`; `ModeBadge` on assistant messages + busy block; Expand/Minimize toggle rendering `LiveRunView`; `inferMode()` helper extracted from `debugDump` |
| [app/history/page.tsx](app/history/page.tsx) | edit — mode chip per conversation card |
| [app/history/[id]/page.tsx](app/history/[id]/page.tsx) | edit — mode chip per assistant turn in the debug view |

`components/` is a new directory (today all components live inline in pages) — keep it flat: `components/flow.tsx`, `components/LiveRunView.tsx`.

## Implementation steps

### Phase 1 — persist and display the mode (small, ship first)

1. **`lib/types.ts`** — add to the `Turn` interface (lib/types.ts:101):
   ```ts
   mode?: Mode; // which pipeline produced this assistant reply (absent on user turns & legacy data)
   ```
2. **`app/api/chat/route.ts`** — `mode` is already destructured from the body (app/api/chat/route.ts:41). Include it in all three `result` sends (lines 61, 63, 70): `send({ type: "result", mode: mode ?? "normal", ... })`.
3. **`lib/chat-runtime.ts`**
   - Add `mode?: Mode` to `ResultEvent` (lib/chat-runtime.ts:38) and to `RunRecord` (line 23).
   - Add `mode?: Mode` to `StartOpts` (line 32) and set it in `startRun`'s initial record (line 85) so the UI knows the running mode *immediately*, not only at completion.
   - In the persisted assistant turn (lines 139-145): `mode: result.mode`.
4. **`app/page.tsx`**
   - Pass `mode: cfg.mode` inside the `startRun` opts (app/page.tsx:463-476), alongside `turns`/`notifications`.
   - Extract the regex heuristic out of `debugDump` (app/page.tsx:1017-1027) into `inferMode(turn: Turn): string` — returns `turn.mode` when set, else the legacy label-regex result. `debugDump` calls it.
   - New tiny `ModeBadge({ mode })` component: a small rounded chip (`Fast` / `Deep` / `Normal`), rendered:
     - in the assistant message footer row (app/page.tsx:1210, next to `Copy`), using `inferMode(turn)`; hide for plain `normal` if it feels noisy — decide visually;
     - in the busy block header next to the label (app/page.tsx:649), from `activeRun.mode`.
5. **`app/history/page.tsx`** — in each conversation card (app/history/page.tsx:84-108), derive the mode of the *last* assistant turn (`inferMode`) and render the chip next to the title; while `isRunning(c.id)`, the "Generating…" badge can include the running mode from `getRun(c.id)?.mode`.
6. **`app/history/[id]/page.tsx`** — render the same chip on each assistant turn header (near the proposals count, app/history/[id]/page.tsx:92-98). Export `inferMode`/`ModeBadge` from a shared spot (put `inferMode` in `lib/conversations.ts` or `components/flow.tsx`; do NOT duplicate).

### Phase 2 — structured stage events end-to-end

7. **`lib/types.ts`** — client-safe stage model:
   ```ts
   export type StageStatus = "pending" | "running" | "done" | "error" | "skipped";
   export interface StageInfo {
     key: string;            // "recon" | "draftA" | "draftB" | "verify" | "synthesize" | "finalize" | "clarify"
     title: string;          // "Recon", "Draft · claude sonnet", …
     provider: string;
     model: string;
     status: StageStatus;
     chars?: number;         // cumulative streamed chars (heartbeat)
     tail?: string;          // last ~1.5k chars of live text (claude-cli stages only)
     output?: string;        // full stage reply — sent once, when the stage completes
     error?: string;
     startedAt?: number;
     endedAt?: number;
   }
   ```
8. **`lib/providers.ts` + `lib/cli.ts`** — live text tail:
   - `ActivityInfo` (lib/providers.ts:19-21) becomes `{ chars: number; tail?: string }`.
   - `runClaude`'s `onData` already parses `content_block_delta` text deltas (lib/cli.ts:276-278) — append `inner.delta.text` to a rolling buffer capped at ~1500 chars and pass `{ chars: streamed, tail }`.
   - `runCodex` (lib/cli.ts:358-364) keeps chars-only: its stdout is progress JSONL, the real answer goes to `outFile`, so there is no clean live text. The UI shows a char counter + spinner for codex stages.
9. **`lib/plan.ts`** — stage emission:
   - Extend the signature: `runPlan(..., onProgress?: ProgressFn, onStage?: (stages: StageInfo[]) => void)`.
   - At the top of `runPlan` (lib/plan.ts:301), build the stage list for the mode:
     - fast: `draftA`, `draftB`, `finalize` ("Verify & finalize");
     - deep: `clarify`, `recon`, `draftA`, `draftB`, `verify`, `synthesize`.
   - Small helper `stage(key, patch)` — mutates the entry, stamps `startedAt`/`endedAt` on status transitions, and calls `onStage(stagesWithoutOutputs)` for ticks / `onStage(stagesWithThisOutput)` on completion (see step 10 payload rule). Throttle activity ticks per stage at 700ms, same pattern as `makeActivity` (lib/plan.ts:324-332).
   - Wire each stage where it already reports progress:
     - clarify pre-check (lib/plan.ts:371-377): `running` → `done` (or all later stages → `skipped` when it returns questions);
     - recon (lib/plan.ts:392-411): activity callback also forwards `chars`/`tail`;
     - drafts (lib/plan.ts:439-450): per-draft status flips inside the existing `.then()` where `agents[i].status` is set;
     - fast finalize (lib/plan.ts:464-499) and deep verify/synthesize (lib/plan.ts:500-574): the retry/fallback paths update the *same* stage (stay `running` through a retry; `error` only when the stage truly ends in error). On the `degraded` fallback (lib/plan.ts:579-585), mark the closing stage `error` — the diagram must not show a ✓ for a stage whose output was discarded.
     - On early clarify return (`clarifyResult`), mark unreached stages `skipped`.
   - Completion sets `output: r.content` (full text) and `error: r.error`.
10. **`app/api/chat/route.ts`** — wire `onStage`: `const onStage = (stages) => send({ type: "stage", stages })` passed as the new last arg of `runPlan` (app/api/chat/route.ts:55). Payload rule (enforced in plan.ts's helper): throttled ticks omit `output`; only the emission fired by a stage completing includes that stage's `output`, once. Keeps the frequent events small while the client still receives every full reply exactly once.
11. **`lib/chat-runtime.ts`** — add `stages?: StageInfo[]` to `RunRecord`; in the SSE loop (lib/chat-runtime.ts:127-134) handle `ev.type === "stage"` by *merging* per key: incoming entries win, except `output` is kept from the existing entry when the incoming one omits it. Leave `stages` on the record when the run finishes (status `done`) so the expanded view doesn't blank out at the moment of completion.

### Phase 3 — the live diagram UI

12. **`components/flow.tsx`** (NEW) — move `Node`, `StepCard`, `PlanCard`, `Pair`, `Hero`, `Fan`, `Spine`, `Label` and the icon set out of app/pipeline/page.tsx:236-395 verbatim; update the pipeline page to import them. Pure refactor — verify the pipeline page renders identically.
13. **`components/LiveRunView.tsx`** (NEW) — props `{ mode: Mode; stages: StageInfo[]; elapsed: string }`.
    - Layout mirrors `DeepFlow`/`FastFlow` (app/pipeline/page.tsx:197-234): prompt node → (recon card) → draft pair → verify card → hero → plan.md node, with `Fan`/`Spine` connectors. `lit`/`dim` come from real stage status instead of timers: a connector lights when the stage after it is `running` or later.
    - Each stage card gains a status row: spinner (running), ✓ (done), ⚠ red (error), dimmed (pending/skipped) + `provider/model` + `fmtChars(chars)` while streaming.
    - **Running stage**: auto-expanded, showing the live `tail` in a scrolling `<pre>` (mono, max-height, auto-scroll to bottom) — this is the "see what models are replying" view. Codex stages show the char counter + "working…" instead of text.
    - **Done stage**: auto-collapses to its compact card the moment `status` flips to `done`; clicking toggles a `<details>`-style body rendering `output` via the existing `Markdown` component (export it or lift it into `components/`). Track per-stage user pins in local state (`Record<string, boolean>`) so a stage the user explicitly opened stays open when the run advances; auto-collapse only applies to stages the user hasn't touched.
    - Parallel drafts render side-by-side in the `Pair` grid, each independently expandable.
14. **`app/page.tsx`** — busy block (app/page.tsx:643-690):
    - Add an `Expand`/`Minimize` toggle button (state `liveOpen: boolean`, reset in `newChat()` and when `convId` changes).
    - Collapsed: exactly today's compact row (spinner, label, elapsed, step counter, thin progress bar).
    - Expanded: keep a slim header (spinner + label + elapsed + Minimize) and render `<LiveRunView mode={activeRun.mode} stages={activeRun.stages} …/>` beneath. Only offer the toggle when `activeRun?.stages?.length` (i.e. plan modes); normal mode keeps the current agent chips.
    - The transcript auto-scroll effect keyed on `[turns, busy, progress]` (app/page.tsx:174) will fight a user reading an expanded stage — suppress auto-scroll while `liveOpen` is true.

### Phase 4 — stretch (only if desired after 1-3)

15. Post-run "View run" on plan-mode assistant turns: map `turn.proposals` (labels are `"model · stage"`, set at lib/plan.ts:336) back to `StageInfo[]` with all statuses `done`/`error` and reuse `LiveRunView` — a static diagram replay of any historical run, replacing/augmenting the flat "Show N agent replies" list (app/page.tsx:1243-1262).
16. Emit stage events from normal mode (`runMoa` in lib/moa.ts) so plain chat gets the same expandable view (proposer fan-out → fuse hero).

## Risks & mitigations

- **SSE payload growth** — a deep run's stage outputs total 30-100KB. Mitigated by the send-output-once rule (step 10) and 700ms tick throttle; everything is localhost so one large event per stage is fine.
- **Stage/`progress` drift** — the old `{done,total,label}` events stay untouched (compact bar + History badge still depend on them); stage events are additive. Don't refactor `bump`/`makeActivity` out — run both.
- **Retry/fallback paths lying in the diagram** — fast-finalize retry (lib/plan.ts:480-492), deep resume-failure fallback (lib/plan.ts:521-533, 555-566) and the `degraded` draft fallback (lib/plan.ts:579-585) all revisit stages. Rule: a stage stays `running` across internal retries and only ever ends `done` (output kept) or `error` (output discarded/failed). Test the degraded path explicitly.
- **Legacy conversations without `turn.mode`** — `inferMode` keeps the existing regex fallback, so old history still shows a best-guess badge; new turns are exact.
- **Tail memory/CPU on the hot stream path** — cap the rolling tail (~1500 chars) with slicing on append, and only build it when `onActivity` is present (both already guarded, lib/cli.ts:265, 359).
- **Auto-collapse vs. user intent** — a user reading a draft mid-run must not have it yanked shut; the per-stage "pinned" state (step 13) covers this. Also suppress transcript auto-scroll while expanded (step 14).
- **`useSyncExternalStore` re-render volume** — stage ticks emit ~1.4/s per running stage; the chat page already re-renders on every progress tick today, so no new pattern, but keep `LiveRunView` memoized on `(stages, mode)` to avoid re-rendering the whole transcript.

## Testing

- `npx tsc --noEmit` and `npm run build` pass (the repo's standing quality gate).
- **Phase 1**: in dev, run one Normal, one Fast, one Deep conversation → assistant replies show the right badge; restart the app → badges persist (mode is in the stored turn JSON under the data dir); History list and `/history/[id]` show chips; a pre-existing old conversation still shows an inferred badge (fallback path).
- **Phase 2**: with a Fast run in flight, watch the network tab's SSE stream → `stage` events appear, outputs arrive exactly once per stage; first verify the merge behavior by logging `getRun(id).stages` in the console mid-run.
- **Phase 3**: start a Deep run on this repo, click Expand → recon shows live streaming text (claude aggregator), drafts run side-by-side (claude shows text, codex shows char counter), each collapses with ✓ on completion and the next stage lights up; re-expand a done draft and confirm it stays open across the next transition; Minimize returns to the compact bar; navigate to History and back mid-run → expanded state resets but stages resume live (they live on the runtime singleton).
- **Failure paths**: kill the codex CLI mid-draft (or point `FUSE_CODEX_BIN` at a bad path) → that draft card goes red ⚠, run continues; force the closing stage to fail twice (temporarily break `hasPlanSections`) → closing stage shows ⚠ not ✓, and the reply carries the existing degraded WARNING banner.
- Optional benchmark sanity: `scripts/bench-plan-modes.sh` still runs clean (it drives `runPlan` via the API and ignores the new events).
