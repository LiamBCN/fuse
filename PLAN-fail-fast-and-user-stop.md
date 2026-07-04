# Plan: Fail-Fast on Agent Errors + User Stop Button (kill all CLI processes per conversation)

## Goal

Two behavior changes to run lifecycle:

1. **Fail fast on agent failure.** Today a failed stage/agent is silently absorbed and the pipeline limps on (falls back to an unverified draft, or fuses fewer proposals). Instead: the moment any agent errors, kill every other CLI process belonging to that run and end the conversation turn with a visible error naming the failed agent.
2. **User-initiated Stop.** While a run is in flight, the UI offers a Stop control. Stopping aborts the SSE request **and** kills every CLI child process (claude/codex "terminals") spawned for that conversation — server-side, via an explicit stop endpoint, so it works even if the disconnect signal never fires.

Both features share one mechanism: a per-run `AbortController` threaded from the API route down to `spawn()`, plus a server-side registry mapping `conversationId → AbortController(s)`.

## Current behavior (evidence)

- `call()` in [lib/plan.ts:209-231](lib/plan.ts#L209) catches every `callModel` error and returns `{ content: "", error }` — **no stage failure ever propagates**. Downstream fallbacks: recon proceeds without a brief (lib/plan.ts:494-527), relay falls back `hard.content || da.content || db.content` (lib/plan.ts:650), fast/recon fall back to the strongest unverified draft with a WARNING banner (lib/plan.ts:774-783).
- MoA degrades a failing proposer to an error proposal ([lib/moa.ts:72-81](lib/moa.ts#L72)) and only errors out if **all** proposers fail (lib/moa.ts:122-125).
- `run()` in [lib/cli.ts:143-206](lib/cli.ts#L143) has no abort path — `RunOpts` (lib/cli.ts:135-139) is only `onData`/`env`. Kills happen only on idle/max timeout via `fail()` → `child.kill("SIGKILL")` (lib/cli.ts:164-167), which kills the direct child only, not grandchildren.
- `drive()` in [lib/chat-runtime.ts:111-191](lib/chat-runtime.ts#L111) fetches `/api/chat` with **no** `signal`; there is no `stopRun()`. The Send button is `disabled={busy}` the whole run ([app/page.tsx:939-948](app/page.tsx#L939)).
- The API route ([app/api/chat/route.ts:50-81](app/api/chat/route.ts#L50)) never looks at `req.signal`, has no `cancel()` on its `ReadableStream`, and persists usage only on success.
- `reconcileRun` ([app/page.tsx:126-142](app/page.tsx#L126)) already handles `status === "error"` with `setError` + `clearRun`, and safely no-ops when a record has been deleted — so user-stop needs **no new RunStatus**: delete the record first, then abort (decision from the earlier stop-button design pass).

## Design

### One cancellation spine

```
UI Stop click ──► stopRun(convId)  [lib/chat-runtime.ts]
                    ├─ clearRun(convId)              (record gone → no error banner)
                    ├─ fetchController.abort()        (kills the SSE fetch)
                    └─ POST /api/chat/stop {conversationId}
                                         │
Server:  run-registry: conversationId ──► internal AbortController.abort()
                                         │            ▲            ▲
                                         │   req.signal (disconnect)│stream cancel()
                                         ▼
         runPlan / runMoa (signal) ──► call()/callModel(signal) ──► runCli ──► run()
                                                                        └─ kill process group (SIGKILL)
```

Agent failure reuses the same spine from the inside: when a stage returns an error, the pipeline aborts its own internal controller (killing sibling processes, e.g. the other draft still streaming), then throws a typed error that the route turns into an SSE `error` event.

### Two typed errors (new `lib/run-control.ts`)

- `AgentFailedError` — carries `stageTitle`, `provider/model`, the underlying message, and `usageItems` collected so far (so partial usage is still persisted). Route sends `{type:"error", error:"Draft · codex-cli/default failed: <msg>. Run stopped."}`.
- `RunStoppedError` — user stop / client disconnect; carries `usageItems`. Route persists partial usage but sends **no** error event (the client already dropped the record; nothing should surface as a failure).

Classification rule inside pipelines: check `signal.aborted` (outer, user-initiated) **before** checking stage errors — a killed sibling also reports an error, and must not be misreported as the cause.

### Failure policy per stage

| Stage | Today on error | New behavior |
|---|---|---|
| clarify pre-screen (recon) | non-fatal, proceed | unchanged — advisory optimization, not an agent of record |
| recon | proceed without brief | **fail run** |
| draft A / draft B | continue with surviving draft | **fail run**, abort internal controller so the sibling draft's CLI process is killed immediately |
| harden (relay) | fall back to draft A | **fail run** |
| verify (recon) | resume-failure → fresh retry; error → continue with empty report | keep the resume→fresh fallback; if the **fresh** call also errors → **fail run** |
| finalize / verify-finalize / synthesize | retry once, then WARNING + unverified-draft fallback | keep the retry; if the retry **errors** → **fail run**. Keep the WARNING fallback **only** for the error-free-but-malformed case (call succeeded, output lacks the five plan sections) — that's a quality degradation, not an agent failure |
| MoA proposers | degrade to error proposal | **fail run**, kill sibling proposers (applies to layer 1 and refine layers) |
| MoA aggregator | already throws uncaught | unchanged (now classified as `AgentFailedError`) |

Note the trade-off: in plain chat (MoA), one flaky CLI now fails an answer that previously degraded gracefully. That is the requested behavior; if it proves too strict, a `failFast: boolean` config escape hatch can be added later without reshaping any of this.

## Affected files

- `lib/run-control.ts` — **NEW** (server-only): `AgentFailedError`, `RunStoppedError`, and the run registry (`registerRun(convId, ac): () => void`, `stopRuns(convId): boolean`) stored on `globalThis` so dev HMR / multiple route modules share one instance.
- `lib/cli.ts` — edit: `signal` support in `run()` + process-group kill; thread signal through `runClaude`/`runCodex`/`runCli`.
- `lib/providers.ts` — edit: `CallArgs` gains `signal?: AbortSignal`; `callModel` forwards it.
- `lib/plan.ts` — edit: `runPlan` gains `signal`; internal linked `AbortController`; fail-fast per the policy table; remove the now-unreachable "every stage errored" text block (lib/plan.ts:774-776).
- `lib/moa.ts` — edit: `runMoa` gains `signal`; fail-fast in `runLayer` + kill-siblings; remove the "All proposer models failed" text path (lib/moa.ts:122-125).
- `app/api/chat/route.ts` — edit: per-request `AbortController`, dual-wired to `req.signal` and the stream's `cancel()`; register/unregister in the run registry; error classification in `catch`; persist partial usage on failure/stop.
- `app/api/chat/stop/route.ts` — **NEW**: `POST { conversationId }` → `stopRuns(conversationId)` → `{ stopped }`.
- `lib/chat-runtime.ts` — edit: per-conversation fetch `AbortController` map; `stopRun(convId)` export; abort-aware `drive()` catch.
- `app/page.tsx` — edit: Send button morphs into a Stop button while `busy`; a "Stop" action in the live progress row.

No changes to `lib/types.ts` — no new `RunStatus`/`StageStatus` values are needed (`error`/`skipped` already exist, and a stopped run's record is deleted, not re-labeled).

## Implementation steps

### 1. `lib/run-control.ts` (new, server-only)

```ts
import type { UsageItem } from "./db";

export class AgentFailedError extends Error {
  constructor(public stageTitle: string, public providerModel: string, cause: string,
              public usageItems: UsageItem[]) {
    super(`${stageTitle} (${providerModel}) failed: ${cause}. Run stopped.`);
  }
}
export class RunStoppedError extends Error {
  constructor(public usageItems: UsageItem[]) { super("Run stopped."); }
}

// conversationId → live controllers. On globalThis so dev hot-reload and any
// duplicate module instances still see one registry (same reasoning as the
// module-singleton chat runtime on the client).
const g = globalThis as { __fuseRuns?: Map<string, Set<AbortController>> };
const registry = (g.__fuseRuns ??= new Map());

export function registerRun(conversationId: string, ac: AbortController): () => void
export function stopRuns(conversationId: string): boolean  // abort all + clear; false if none
```

### 2. `lib/cli.ts` — abortable, process-group-killing `run()`

- `CliOpts` (lib/cli.ts:15-19) gains `signal?: AbortSignal`. `RunOpts` (lib/cli.ts:135-139) gains `signal?: AbortSignal`.
- In `run()` (lib/cli.ts:143):
  - Spawn with `detached: true` and add a `killTree()` helper: `try { process.kill(-child.pid!, "SIGKILL") } catch { child.kill("SIGKILL") }`. Use it in `fail()` (lib/cli.ts:164-167) so idle/max-timeout kills also take down grandchildren (codex sandbox helpers etc.).
  - At entry: `if (opts.signal?.aborted) { reject(new Error("Run stopped.")); return; }`.
  - `const onAbort = () => fail("Run stopped.");` + `opts.signal?.addEventListener("abort", onAbort)`; remove the listener inside `done()` (lib/cli.ts:157-163), the established cleanup slot for the two timers.
- `runClaude`: pass `signal: opts?.signal` into both `run()` calls (lib/cli.ts:319 and the max-turns retry at :324). `runCodex`: same for its `run()` call (lib/cli.ts:409) — its `finally` already unlinks `outFile`, which still executes on abort-rejection.
- Do **not** touch the setup probes (`probeVersion`, `probeClaudeAuth`) — they have their own timeouts.

### 3. `lib/providers.ts` — thread the signal

`CallArgs` (lib/providers.ts:37-47) gains `signal?: AbortSignal`; `callModel` (lib/providers.ts:49-56) forwards it in the `runCli` opts object.

### 4. `lib/plan.ts` — fail-fast pipeline

- `runPlan` (lib/plan.ts:303) gains a trailing `signal?: AbortSignal` param. Build an internal linked controller: `const ac = new AbortController(); signal?.addEventListener("abort", onOuterAbort)` (remove the listener before returning/throwing). All `call()` invocations get `ac.signal`.
- `call()` (lib/plan.ts:209) gains `signal?: AbortSignal`, forwarded to `callModel`. It keeps absorbing errors into `{ error }` — classification stays in `runPlan`.
- Helpers inside `runPlan`:
  - `const assertNotStopped = () => { if (signal?.aborted) { skipPendingStages(); throw new RunStoppedError(usageItems); } }` — call it after **every** stage completes (including the clarify screen).
  - `const failStage = (key: StageKey, model: ModelRef, msg: string): never => { skipPendingStages(); throw new AgentFailedError(stageTitleOf(key), `${model.provider}/${model.model}`, msg, usageItems); }`.
- Apply the policy table:
  - recon (lib/plan.ts:521-526): after `stage(...)`/`bump`/`record`, `if (rec.error) failStage("recon", reconModel, rec.error)` — delete the "drafters just proceed without a brief" fallback.
  - drafts (lib/plan.ts:558-571): inside each `.then`, add `if (r.error) ac.abort()` so the sibling's CLI process dies immediately; keep both `record()` calls (a killed sibling shows as an error proposal in the debug view). After `Promise.all`: `assertNotStopped()`, then fail on `da.error` first, then `db.error` (the aborter is the real cause; the killed sibling's "Run stopped." error is a casualty). Keep the `@@CLARIFY@@` consolidation after this — clarify only matters when both drafts actually completed.
  - relay harden (lib/plan.ts:638-648): `if (hard.error) failStage("harden", hardenModel, hard.error)`; keep the empty-content-no-error fallback to `da.content`.
  - fast verify-finalize (lib/plan.ts:595-631), relay finalize (lib/plan.ts:654-686), recon synthesize (lib/plan.ts:734-771): keep the single retry; after it, `if (fin.error) failStage(...)`. The `hasPlanSections` degraded/WARNING fallback (lib/plan.ts:774-783) now only triggers when the call succeeded but wrote a malformed plan.
  - recon verify (lib/plan.ts:698-725): keep the resume→fresh fallback exactly as is; after the fresh call, `if (ver.error) failStage("verify", verifyModel, ver.error)`.
  - Remove the unreachable `!final?.trim()` "every stage errored" block (lib/plan.ts:774-776).

### 5. `lib/moa.ts` — fail-fast MoA

- `runMoa` (lib/moa.ts:86) gains `signal?: AbortSignal`; same internal linked controller pattern; pass `ac.signal` to every `callModel` (proposers lib/moa.ts:62, aggregator :137).
- `runLayer` (lib/moa.ts:39): keep the per-proposer try/catch (proposals still record errors for the debug view) but have the catch call `onOne(i, p, true)` **and** a new `onError?: () => void` that aborts `ac`. After each layer resolves in `runMoa`: if `signal?.aborted` → `RunStoppedError(usageItems)`; else if any `proposals[i].error` where the error is not the kill-message → `AgentFailedError("Proposer", provider/model, error, usageItems)` (pick the first non-"Run stopped." error as the cause).
- Wrap the aggregator call in try/catch with the same classification.
- Delete the `good.length === 0` "All proposer models failed" result (lib/moa.ts:122-125) — unreachable under fail-fast.

### 6. `app/api/chat/route.ts` — wire the registry + classification

Restructure `POST` (app/api/chat/route.ts:34) so the controller exists before the stream:

```ts
const ac = new AbortController();
const convKey = conversationId ?? "default";
const unregister = registerRun(convKey, ac);
const onReqAbort = () => ac.abort();
req.signal.addEventListener("abort", onReqAbort);   // client disconnect (unverified in Next 14 → dual-wired)

const stream = new ReadableStream({
  async start(controller) {
    ...
    try {
      const result = await runPlan(..., stageModels, ac.signal);   // / runMoa(..., ac.signal)
      ...
    } catch (e) {
      const items = (e instanceof AgentFailedError || e instanceof RunStoppedError) ? e.usageItems : [];
      if (items.length) await appendUsage({ ts: Date.now(), conversationId: convKey, items }).catch(() => {});
      if (!(e instanceof RunStoppedError)) {
        try { send({ type: "error", error: e?.message ?? String(e) }); } catch { /* client gone */ }
      }
    } finally {
      req.signal.removeEventListener("abort", onReqAbort);
      unregister();
      try { controller.close(); } catch {}
    }
  },
  cancel() { ac.abort(); },   // consumer stopped reading → same as disconnect
});
```

Success paths keep their existing `appendUsage` calls; `enqueue` after a client disconnect throws, which lands in the same `catch` — that's why partial-usage persistence lives there.

### 7. `app/api/chat/stop/route.ts` (new)

```ts
import { NextRequest, NextResponse } from "next/server";
import { stopRuns } from "@/lib/run-control";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  const { conversationId } = await req.json().catch(() => ({}));
  if (!conversationId) return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  return NextResponse.json({ stopped: stopRuns(conversationId) });
}
```

### 8. `lib/chat-runtime.ts` — `stopRun()`

- Module-level `const fetchControllers = new Map<string, AbortController>();`
- `startRun` (lib/chat-runtime.ts:103): create the controller, store it, pass to `drive`.
- `drive` (lib/chat-runtime.ts:111): `fetch("/api/chat", { ..., signal })`; in a `finally`, `fetchControllers.delete(convId)`. In the `catch` (lib/chat-runtime.ts:188-190), return early on `e?.name === "AbortError"` — belt-and-braces; normally the record is already deleted so `patch()` no-ops.
- New export:

```ts
export function stopRun(convId: string): void {
  if (runs.get(convId)?.status !== "running") return;
  clearRun(convId);                       // delete BEFORE abort → drive()'s catch finds no record, no error banner
  fetchControllers.get(convId)?.abort();  // tear down the SSE fetch
  void fetch("/api/chat/stop", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: convId }), keepalive: true,
  }).catch(() => {});                     // authoritative server-side kill of all CLI children
}
```

No chime/notification fires on stop: those live on `drive()`'s success path only.

### 9. `app/page.tsx` — Stop UI

- Import `stopRun` from `@/lib/chat-runtime` (extend the import at app/page.tsx:17).
- Composer send button (app/page.tsx:939-948): when `busy`, render a Stop button in its place — same size/shape, square-in-circle icon (`<rect x="7" y="7" width="10" height="10" rx="1.5"/>`), `aria-label="Stop"`, `onClick={() => stopRun(convId.current)}`, never disabled. When `!busy`, the existing Send button renders unchanged.
- Live progress rows (both branches, app/page.tsx:664-690): add a `Stop` text button next to Minimize/Expand calling the same handler, so the run can be stopped from where the user is actually watching it.
- Nothing else changes: `busy` flips false the instant `stopRun` deletes the record (`useSyncExternalStore` re-render), which unmounts the progress row and `LiveRunView` and re-enables Send. The user turn stays in the transcript with no assistant reply — same as stopping in any chat app. Agent-failure errors arrive through the existing path: `drive()` throws on the SSE `error` event → record status `error` → `reconcileRun` (app/page.tsx:129-132) shows the banner.

### 10. Verify

`npx tsc --noEmit` and `npm run build`, then the manual matrix in Testing.

## Risks & mitigations

- **`req.signal` may not fire on client disconnect in Next 14 Node runtime** (unverified from the earlier design pass). Mitigated three ways: `req.signal` listener + `ReadableStream.cancel()` + the explicit `/api/chat/stop` endpoint. The explicit endpoint alone is sufficient for the Stop button; the other two cover tab-close/navigation.
- **`detached: true` + group kill (`process.kill(-pid)`)**: on macOS this makes the child a process-group leader so the whole tree dies (codex spawns helpers). Guard with try/catch falling back to `child.kill("SIGKILL")`, and keep `child.pid` null-checks — spawn failures leave `pid` undefined.
- **Misclassifying a killed sibling as the failure cause**: when draft A fails and aborts the internal controller, draft B dies with "Run stopped.". Always check the *outer* signal for user-stop first, then pick the first stage error that is not the kill message. The sibling still shows as an error proposal in the debug view — acceptable and honest.
- **Fail-fast makes plain chat (MoA) brittler**: one flaky CLI now fails answers that previously degraded to fewer proposals. This is the requested behavior; if it hurts in practice, add a `failFast` config bit later — the throw sites are centralized so it's a two-line gate.
- **Stop racing run completion**: if the user clicks Stop just as `drive()` persists the assistant turn, the record is deleted but the turn was already saved — it appears when the conversation reloads. Harmless; `stopRuns` finds no live controllers and no-ops. Conversely `startRun` immediately allows a new run after stop (record deleted), while SIGKILL'd children die asynchronously — they write nothing afterward (codex `outFile` is already unlinked in `finally`), so no interference.
- **Registry leaks**: every code path through the route hits `finally → unregister()`; the registry entry holds only `AbortController`s, and `stopRuns` clears the conversation's set. Dev HMR is covered by the `globalThis` singleton.
- **Partial usage loss on failure/stop**: avoided by carrying `usageItems` on both error classes and persisting them in the route's `catch`. In-flight (killed) stages contribute zero usage by design — `record()` already skips errored results (lib/plan.ts:441-446).

## Testing

Run the app with `npm run dev` (or the packaged app) with a folder selected.

1. **Type/build gate**: `npx tsc --noEmit` && `npm run build` pass.
2. **Agent failure fails the run (plan mode)**: in Settings, point draft B at a bogus model (e.g. codex model name `nonexistent-model`); start a recon or fast run. Expect: draft B flips to Error in the live view, draft A's CLI process disappears from `ps aux | grep -E "claude|codex"` within ~1s, remaining stages show Skipped, and the chat shows an error banner naming `draftB`'s provider/model. Verify partial usage rows exist for completed stages (recon) in the usage store, and no `fuse-plan-*.md` was written.
3. **Agent failure fails the run (chat mode)**: same bogus proposer with no folder; expect the error banner instead of a degraded fused answer.
4. **Stop button (plan mode)**: start a recon run; while drafts are streaming, click Stop. Expect: progress UI disappears immediately, Send re-enables, **no** error banner, and within ~1s `ps aux | grep -E "claude|codex"` shows no CLI children for the run. Server log shows no unhandled rejection.
5. **Stop kills the whole tree**: during a codex draft, note the codex pid and any child pids (`pgrep -P <pid>`); after Stop, confirm both are gone (process-group kill).
6. **Conversation isolation**: start plan runs in two conversations (the runtime supports concurrent convs); stop one. The other's run must keep streaming to completion.
7. **Disconnect path**: start a run, close the tab entirely, reopen; confirm via `ps` that CLI children were reaped (covers `req.signal`/`cancel()` wiring; if they linger, the explicit stop endpoint still covers the button path — investigate before shipping).
8. **Stop endpoint is idempotent**: `curl -X POST localhost:3030/api/chat/stop -H 'content-type: application/json' -d '{"conversationId":"nope"}'` → `{"stopped":false}`, HTTP 200.
9. **Regression**: a normal fast-mode run with healthy models completes, writes the plan file, shows usage, and the retry/WARNING fallback still engages when the finalize output is malformed but error-free (can be simulated by temporarily tightening `hasPlanSections`).
