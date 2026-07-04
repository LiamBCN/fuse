# Plan: Clear Error Display + Live 5h/Weekly Usage Limits (Claude & Codex) + Per-Conversation Limit Attribution

## Goal

Four related upgrades:

1. **Clear, clean error display.** Stage failures currently surface as one raw concatenated string (`Draft (claude-cli/default) failed: <CLI stderr>. Run stopped.`) in a plain bordered div. Instead: classify every failure (rate-limit / auth / timeout / stopped / unknown), render a structured error banner with a human title, the provider, the failed stage, and — for rate limits — a live "resets at" countdown.
2. **Live remaining usage for the 5-hour and weekly limits, from both Claude and Codex.** A small always-visible meter (Nav) plus a full breakdown (Stats page), refreshed after every turn and while runs are active.
3. **Per-conversation cost against those limits.** Every reply already records token usage; additionally snapshot both providers' limit utilization before/after each turn and store the delta, so each turn and each conversation shows "≈X% of the Claude 5h window, ≈Y% of weekly" (and same for Codex).
4. **Benchmarks integration.** Bench runs are the heaviest consumers: capture per-rep limit deltas so contender cost is comparable in "% of 5h window", add a pre-flight budget gate, and stop rate-limit failures from polluting pass^k scores.

## Evidence (all verified live on this machine, 2026-07-03)

### The trigger bug (already fixed today — prerequisite, done)

`isClaudeAuthFailure()` in [lib/cli.ts:85](lib/cli.ts#L85) used to match `apiKeySource:"none"`, which the CLI's `system/init` event **always** emits for subscription logins. Any `is_error` result (e.g. a 429 session limit) was therefore relabeled "Claude CLI not authenticated — run `claude setup-token`". Fixed: the regex now only matches genuine logged-out signals. A 429 now surfaces with its real message — this plan makes that message *good*.

### Claude limits: the OAuth usage endpoint works headlessly

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <oauth access token>
anthropic-beta: oauth-2025-04-20
```

Verified response (live, trimmed):

```json
{
  "five_hour": { "utilization": 100.0, "resets_at": "2026-07-03T15:50:00Z" },
  "seven_day": { "utilization": 31.0,  "resets_at": "2026-07-05T17:00:00Z" },
  "limits": [
    { "kind": "session",       "percent": 100, "severity": "critical", "resets_at": "...", "is_active": true },
    { "kind": "weekly_all",    "percent": 31,  "severity": "normal",   "resets_at": "..." },
    { "kind": "weekly_scoped", "percent": 19,  "scope": { "model": { "display_name": "Fable" } } }
  ]
}
```

Token resolution order (all three verified to exist as sources):
1. `CLAUDE_CODE_OAUTH_TOKEN` env (packaged-app path)
2. Fuse settings `claudeOauthToken` (`readSettings()` in [lib/settings-store.ts:19](lib/settings-store.ts#L19))
3. macOS Keychain: `security find-generic-password -s "Claude Code-credentials" -w` → JSON → `.claudeAiOauth.accessToken` (this is how the user's terminal login is stored; verified it returns a working 108-char token)

⚠️ This endpoint is **undocumented** — treat as best-effort, parse defensively, degrade to "unavailable" without ever blocking chat.

### Codex limits: in rollout files, NOT in the exec event stream

- `codex exec --json` emits only `thread.started / turn.started / item.completed / agent_message / turn.completed / error` — **no** rate limits (verified on codex-cli 0.142.5).
- But every exec run writes `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl` containing `token_count` events with:

```json
"rate_limits": {
  "primary":   { "used_percent": 5.0,  "window_minutes": 300,   "resets_at": 1783088674 },
  "secondary": { "used_percent": 29.0, "window_minutes": 10080, "resets_at": 1783389736 },
  "plan_type": "pro"
}
```

`primary` = the 5h window, `secondary` = weekly. The filename ends with the `thread_id` that `runCodex` already captures from `thread.started` ([lib/cli.ts:441](lib/cli.ts#L441)) — so after any codex call we can locate its rollout deterministically. For a passive read (no run in flight), the newest rollout file overall is the freshest account-level snapshot.

### Current error path (what "clean display" replaces)

- `AgentFailedError` builds the raw string in [lib/run-control.ts:10](lib/run-control.ts#L10).
- Route sends `{ type: "error", error: string }` ([app/api/chat/route.ts:89](app/api/chat/route.ts#L89)) — no structure.
- UI renders it as a plain div ([app/page.tsx:801](app/page.tsx#L801)); per-proposal errors are raw red text ([app/page.tsx:1357](app/page.tsx#L1357)).

### Current usage tracking (what limit attribution extends)

- Per-turn `UsageRecord { ts, conversationId, items[] }` appended to `data/usage.json` ([lib/db.ts](lib/db.ts)).
- Per-reply `turn.usage` chip already rendered ([app/page.tsx:1334](app/page.tsx#L1334)).
- Stats page aggregates by day/model via `/api/usage` ([app/stats/page.tsx](app/stats/page.tsx)).
- Bench already records `usage` + `usageItems` per run ([lib/bench-types.ts:65](lib/bench-types.ts#L65)).

## Design

### 1. New module: `lib/limits.ts` (server-only)

```ts
export interface LimitWindow {
  usedPercent: number;        // 0–100
  resetsAt: number | null;    // epoch ms
  windowMinutes: number;      // 300 or 10080
}
export interface ProviderLimits {
  provider: "claude" | "codex";
  session: LimitWindow | null;   // the 5h window
  weekly: LimitWindow | null;
  scoped?: { label: string; usedPercent: number }[]; // Claude per-model weekly (e.g. Fable)
  planType?: string;
  fetchedAt: number;
  error?: string;                // present ⇒ meters show "unavailable", never throw
}

export async function fetchClaudeLimits(): Promise<ProviderLimits>;
export async function fetchCodexLimits(): Promise<ProviderLimits>;
export async function fetchAllLimits(): Promise<{ claude: ProviderLimits; codex: ProviderLimits }>;
```

- `fetchClaudeLimits`: resolve token (env → settings → Keychain via `security`, in that order; cache which source worked), call the OAuth endpoint with a 5s timeout.
- `fetchCodexLimits`: glob the newest `rollout-*.jsonl` under `~/.codex/sessions/` (bounded: walk newest date dirs only), read the **last** `rate_limits` occurrence (read file tail, not the whole rollout — they reach many MB). Optional `threadId` param to target a specific run's rollout.
- Module-level cache with ~45s TTL (the background-runtime singleton pattern already used in [lib/chat-runtime.ts](lib/chat-runtime.ts)); `force` param to bypass after a turn completes.
- New route `GET /api/limits` (+ `?force=1`) returning `fetchAllLimits()`.

### 2. Structured errors end-to-end

New `classifyCliError(message: string): ErrorInfo` in `lib/run-control.ts`:

```ts
export interface ErrorInfo {
  kind: "rate-limit" | "auth" | "timeout" | "stopped" | "unknown";
  provider?: "claude" | "codex";
  stage?: string;               // "Draft", "Recon", …
  providerModel?: string;       // "claude-cli/default"
  message: string;              // human detail (the real CLI message)
  resetsAt?: number;            // parsed from "resets 5:50pm (Europe/Madrid)" or api_error_status 429 + /api/limits
}
```

Classification rules (against real strings observed today):
- `/hit your session limit|api_error_status["\s:]*429|rate.?limit|usage limit/i` → `rate-limit`; parse `resets <time> (<tz>)` when present, else fill `resetsAt` from a fresh `/api/limits` call server-side.
- The existing `isClaudeAuthFailure` patterns → `auth`.
- `/No output for \d+s|Exceeded the \d+s hard limit/` → `timeout`.
- `RunStoppedError` → `stopped` (never rendered as failure — unchanged behavior).

Wire-up:
- `AgentFailedError` gains an `info: ErrorInfo` field; its `message` stays as-is for back-compat/logs.
- SSE error event becomes `{ type: "error", error: string, info?: ErrorInfo }` ([app/api/chat/route.ts:89](app/api/chat/route.ts#L89)). Old clients that only read `error` keep working.
- For `kind: "rate-limit"` on claude, the route attaches the **other** provider's availability (from cached limits) so the banner can suggest "Codex weekly at 29% — switch models in Settings".

New `components/ErrorBanner.tsx` replacing the plain div at [app/page.tsx:801](app/page.tsx#L801):
- Icon + title per kind: *"Claude usage limit reached"* / *"Claude CLI not authenticated"* / *"Agent timed out"* / generic.
- Subtitle: stage + provider/model badge (reuse `ModeBadge` styling).
- For rate-limit: live countdown to `resetsAt` in the **user's local time** ("resets 17:50 · in 1h 38m") + both providers' current meters inline + a "Retry" button that resends the last user message once the reset passes (enabled state driven by the countdown).
- Per-proposal errors ([app/page.tsx:1357](app/page.tsx#L1357)): show the classified one-line title, full raw message behind the already-present `<details>` expansion.

### 3. Per-conversation limit attribution (the delta-snapshot trick)

Both APIs report **percent**, not tokens — so per-conversation "how much of my limit" is measured as a utilization delta:

- In the chat route, before running the pipeline: `before = await fetchAllLimits()` (cached is fine). After the run (success *or* AgentFailedError — partial usage is already persisted): `after = await fetchAllLimits(force)`. For codex, prefer the turn's own rollout (threadId comes back via `CallResult.sessionId` already).
- Extend `UsageRecord` ([lib/db.ts](lib/db.ts)):

```ts
limits?: {
  claude?: { sessionDeltaPct: number; weeklyDeltaPct: number };
  codex?:  { sessionDeltaPct: number; weeklyDeltaPct: number };
  approx?: boolean;   // true when a window reset mid-turn or another session ran concurrently
};
```

- Delta rules: clamp at ≥0; if `resetsAt` changed between snapshots the window rolled over mid-turn → set `approx: true` and use `after.usedPercent` alone as the upper bound. Always label with "≈" in UI — a terminal Claude Code session running concurrently also moves the meter (unavoidable; deltas measure account consumption during the turn).
- Turn chip ([app/page.tsx:1334](app/page.tsx#L1334)): tooltip extended to `"38,412 tokens · ≈2.5% of Claude 5h · ≈0.4% weekly · ≈1.1% Codex 5h"`.
- Conversation totals: sum deltas per `conversationId`. Surface in:
  - **History list** ([app/history/page.tsx](app/history/page.tsx)): small "≈X% 5h" chip per conversation.
  - **Stats page**: new per-conversation table — tokens in/out, ≈% of 5h, ≈% of weekly, split by provider (extend `/api/usage` aggregation, which already groups by `conversationId`).

### 4. Live usage meters

- `components/LimitMeter.tsx`: compact dual bar per provider (5h + weekly), colored by severity (normal <70% / warn <90% / critical ≥90%), reset time on hover. Rendered in [components/Nav.tsx](components/Nav.tsx) (collapsed: two tiny bars; click → popover with full numbers incl. Claude per-model scoped weekly and Codex plan type).
- Refresh policy: on app load, after every completed turn (`force`), every 60s while a run is in flight, otherwise on window focus. All through `GET /api/limits` — the client never touches Keychain or `~/.codex`.
- Composer warning: when the session window of any provider used in the current mode's stage models is ≥90% (or exhausted), show an inline warning above the input — *"Claude 5h at 100%, resets 17:50. Codex has 95% of its 5h left — switch stage models in Settings, or wait."* Send stays enabled (the server error path now reports cleanly if the user pushes through).

### 5. Benchmarks integration

- **Per-rep deltas**: in the bench runner, snapshot limits before/after each contender rep (same helper as chat); store on the run record — extend [lib/bench-types.ts](lib/bench-types.ts) run shape with `limitDelta?: UsageRecord["limits"]`.
- **Summary table**: add a "≈% of 5h" column next to tokens per contender — makes mode cost directly comparable ("Recon: 3.1% of a Claude 5h window/rep vs Fast: 0.9%") and feeds the Fast/Deep consolidation decision.
- **Pre-flight gate**: before starting a suite, `fetchAllLimits(force)`; if any provider a contender uses is ≥85% on its session window → warning dialog in the Benchmarks UI with remaining % + reset times and an explicit "run anyway". (A suite that dies of 429s halfway wastes the whole run.)
- **Rate-limited reps don't poison scores**: if a rep fails with `kind: "rate-limit"`, mark the rep `rateLimited` instead of failed — exclude from pass^k and judge averages, surface as an amber chip. Optionally: pause the suite until `resetsAt` (idle-wait, reuse the run-control abort so Stop still works), then resume remaining reps.

## Files

**New**
- `lib/limits.ts` — fetchers, cache, normalization
- `app/api/limits/route.ts` — `GET /api/limits`
- `components/ErrorBanner.tsx` — classified error UI
- `components/LimitMeter.tsx` — provider meters (Nav + popover + composer warning)

**Modified**
- `lib/run-control.ts` — `ErrorInfo`, `classifyCliError`, extend `AgentFailedError`
- `lib/cli.ts` — tag thrown errors with provider; (already returns codex `thread_id` as `sessionId`)
- `lib/db.ts` — `UsageRecord.limits`
- `app/api/chat/route.ts` — before/after snapshots, structured SSE error, persist deltas
- `app/api/usage/route.ts` — per-conversation aggregation incl. limit deltas
- `app/page.tsx` — ErrorBanner, extended turn chip, composer warning
- `app/history/page.tsx` — per-conversation limit chip
- `app/stats/page.tsx` — per-conversation table + current meters
- `components/Nav.tsx` — LimitMeter
- `lib/bench.ts`, `lib/bench-types.ts`, `lib/bench-store.ts`, `app/benchmarks/*` — gate, per-rep deltas, `rateLimited` rep state, summary column

## Risks / mitigations

| Risk | Mitigation |
|---|---|
| OAuth usage endpoint is undocumented; shape can drift | Defensive parsing; any failure → `ProviderLimits.error`, meters show "unavailable", chat never blocked |
| Keychain read may prompt/fail from the packaged app | Fall back through env → settings token; meters degrade per-provider independently |
| Rollout format is internal to codex-cli (verified on 0.142.5) | Tail-read + tolerant JSON scan; version-gate note in code comment |
| Delta attribution counts concurrent terminal sessions | Always "≈", `approx` flag when reset crossed; documented in tooltip |
| Percent-only granularity (1% steps observed) | Small turns may show 0% — display "<1%" when tokens > 0 but delta = 0 |
| Extra latency per turn from snapshots | `before` uses the 45s cache; `after` is one HTTPS call + one file tail read, off the SSE critical path (fire after `result` event is sent) |

## Implementation order

1. **Phase 1 — limits core**: `lib/limits.ts` + `/api/limits` + a `scripts/limits-probe.sh` that prints both providers' parsed snapshots (validates against today's live values: Claude 100%/31%, Codex 5%/29%).
2. **Phase 2 — structured errors**: `classifyCliError` + typed SSE + `ErrorBanner` (unit-test the classifier against the real strings captured today, including the exact 429 result and the old auth string).
3. **Phase 3 — attribution**: snapshots in the chat route, `UsageRecord.limits`, turn chip + history + stats surfaces.
4. **Phase 4 — meters**: Nav widget, popover, composer warning.
5. **Phase 5 — bench**: pre-flight gate, per-rep deltas, `rateLimited` rep handling, summary column.
6. **Phase 6 — validation**: typecheck + production build; live smoke: run one turn on each provider, confirm chip deltas; trip the Claude limit case (trivially reproducible today until 17:50 local) and confirm the banner shows kind=rate-limit with countdown instead of the old auth message.

## Testing strategy

- **Classifier unit tests** with verbatim fixtures: today's 429 `result` JSON, `isClaudeAuthFailure` strings, idle-timeout message, codex `error` event.
- **Limits parsing fixtures**: the captured OAuth response and rollout `token_count` line checked into `lib/__fixtures__/`.
- **Live probe script** for both fetchers (fails loud if either source's shape drifted — run it before releases).
- **Bench dry-run** with a mocked `fetchAllLimits` at 95% to verify the gate dialog and `rateLimited` rep path without burning real quota.
