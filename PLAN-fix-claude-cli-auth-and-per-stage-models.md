# Plan: Fix `claude-cli` pipeline auth failures + per-stage Opus 4.8 / Sonnet 5 selection

## Goal

Two independent problems, one plan:

1. **Fix the errors.** Every `claude-cli` stage in your `relay` and `recon` runs failed
   with `authentication_failed` / `"Not logged in · Please run /login"`, while every
   `codex-cli` stage succeeded. The Claude CLI that Fuse spawns cannot see your
   subscription login, so all Claude stages die and the pipeline is left with only the
   Codex drafts (and no final Claude synthesis).

2. **Per-stage model control.** Let the pipeline run **Opus 4.8** in some stages and
   **Sonnet 5** in others, deterministically, instead of only the current per-role
   (`proposerA` / `proposerB` / `aggregator`) mapping with fuzzy `opus`/`sonnet` aliases.

Both must keep Fuse **CLI/subscription-only** — no metered `ANTHROPIC_API_KEY`, per
[fuse-cli-providers].

---

## Root cause of the errors (verified)

The giant error blobs are noise from the `claude-mem` `SessionStart` hook. The actual
failure is the synthetic message at the end of each stage:

```json
{"type":"result","subtype":"success","is_error":true,
 "result":"Not logged in · Please run /login", ... }
{"apiKeySource":"none", ... "model":"claude-opus-4-8" ...}
```

Why only Claude fails and Codex doesn't:

- **Codex** reads its credentials from files under `~/.codex`. A GUI-spawned child
  process inherits `HOME` (Fuse sets it explicitly at `lib/cli.ts:72`) and reads those
  files fine → Codex stages succeed.
- **Claude Code on macOS stores its OAuth token in the login Keychain**, not in a file.
  Verified on this machine:
  - `~/.claude/.credentials.json` does **not** exist.
  - `security find-generic-password -s "Claude Code-credentials"` **does** exist
    (a `max` subscription token).

  Keychain items are ACL-gated **per calling application**. The item was authorized for
  your terminal app (iTerm/Terminal), where interactive `claude` works. When **Fuse.app**
  (an Electron GUI, per [fuse-app-deployment]) spawns `claude` non-interactively, Fuse.app
  is not on that item's ACL and there is no TTY to answer a Keychain prompt → access
  denied → `claude` sees no token → `apiKeySource: none` → "Not logged in".

Corroborating evidence from the two debug dumps (relay `3 errors` + recon `4 errors`,
re-verified 2026-07-03):

- Fails identically in both working dirs (`/Users/liam/migma-both` and the neutral temp
  dir `…/T/fuse-cli`) → not cwd-related.
- Fails identically with the CLI's default model (`claude-opus-4-8[1m]`) and with an
  explicit `--model opus` → not model-related.
- Every failed stage shows `duration_api_ms: 0`, `model: "<synthetic>"`, and
  `apiKeySource: "none"` → the CLI never reached the API; it failed its **local** auth
  check before making any request.
- `codex-cli` stages succeeded in the very same runs → Fuse's spawn env (HOME/PATH) is
  fine; the difference is purely *where each CLI keeps credentials* (files vs Keychain).

This also explains why the **setup gate missed it**: `probeCli()` only runs
`claude --version` (`lib/cli.ts:428-448`), which succeeds whether or not the CLI is
authenticated.

### The fix: `CLAUDE_CODE_OAUTH_TOKEN` (subscription, not API key)

Claude Code supports a long-lived OAuth token minted from your subscription via
`claude setup-token` (verified present on the installed CLI, 2.1.198: *"Set up a
long-lived authentication token (requires Claude subscription)"*), supplied to
non-interactive/programmatic invocations through the `CLAUDE_CODE_OAUTH_TOKEN`
environment variable. This is the officially supported headless
path, it uses the **Max subscription** (not metered API billing), and it is file/env-based
so it sidesteps the Keychain-ACL problem entirely. Fuse just needs to obtain that token
once and inject it into the child environment it already builds in `childEnv()`.

---

## Affected files

| File | Change |
|------|--------|
| `lib/cli.ts` | **edit** — inject `CLAUDE_CODE_OAUTH_TOKEN` into `childEnv()`; add an auth-aware health probe; surface a clean "not logged in" error instead of the raw stream blob. |
| `lib/config` / settings store (`app/api/setup` + wherever `FuseConfig` persists) | **edit** — persist the OAuth token (or read it from env) so it's available server-side. |
| `lib/types.ts` | **edit** — add optional `stageModels` override map to `FuseConfig`; keep `mergeConfig` backward-compatible. |
| `lib/plan.ts` | **edit** — resolve each stage's `ModelRef` through the `stageModels` override (falling back to the current role mapping). |
| `app/api/setup/route.ts` (setup gate) | **edit** — report Claude auth status (logged-in vs not), not just binary presence. |
| Settings UI (`app/page.tsx` settings panel) | **edit** — add a field to paste the `setup-token` output and (optionally) per-stage model pickers. |

---

## Implementation steps

### Part A — Fix Claude CLI authentication

1. **Mint the token (one-time, user action).** Run in a terminal that is already logged in:

   ```
   claude setup-token
   ```

   Copy the emitted `CLAUDE_CODE_OAUTH_TOKEN` value. It's long-lived and tied to the Max
   subscription — no per-token API cost.

2. **Store it for the server.** Add `claudeOauthToken?: string` to the persisted config
   (or read `process.env.CLAUDE_CODE_OAUTH_TOKEN` if the user prefers env). Never log it;
   never send it to the client after save.

3. **Inject it into the child env.** In `lib/cli.ts`, extend `childEnv()` (currently
   `lib/cli.ts:71-75`) so the spawned `claude` receives the token:

   ```ts
   const childEnv = (extra?: Record<string, string>) => ({
     ...process.env,
     HOME,
     PATH: [...EXTRA_DIRS, process.env.PATH || ""].join(":"),
     ...(claudeOauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeOauthToken } : {}),
     ...extra,
   });
   ```

   Only pass it to the Claude spawn (`runClaude`), not Codex — keep providers isolated.

4. **Auth-aware health probe.** `probeVersion()` (`lib/cli.ts:428`) proves the binary
   runs but not that it's authenticated. Add a second probe that runs a trivial prompt,
   e.g. `claude -p "ok" --output-format json --tools ""`, and treats a `result` event
   with `is_error` + `Not logged in` as **unauthenticated** (distinct from "missing"). Wire
   this into `detectClis()` so the setup gate can say *"Claude found but not logged in —
   run `claude setup-token` and paste the token in Settings."*

5. **Clean error surfacing.** In `runClaude`, the parse loop already sets
   `data.is_error` (`lib/cli.ts:311`). Special-case the not-logged-in result so the stage
   error is the short string `"Claude CLI not authenticated — see Settings"` rather than
   the full hooked stream-json dump shown in your debug output.

6. **(Optional) Silence the hook noise.** The `claude-mem` `SessionStart` hook injects
   ~20 KB of context into every stage's stdout and adds latency. For Fuse's programmatic
   spawns, pass `--strict-mcp-config` / a minimal settings dir, or set an env flag the
   hook respects, so pipeline stages run clean. Non-blocking; do after auth works.

### Part B — Per-stage Opus 4.8 / Sonnet 5 selection

Today the stage→model mapping is fixed by role (`lib/plan.ts:331-352`):

- `fast`: draftA=**A**, draftB=**B**, finalize=**aggregator**
- `relay`: draftA=**A**, draftB=**B**, harden=**B**, finalize=**aggregator**
- `recon`: clarify=**A**, recon=**aggregator**, draftA=**A**, draftB=**B**, verify=**aggregator**, synthesize=**aggregator**

So you *already* get "Opus in some places, Sonnet in others" by setting
`aggregator = claude-cli/opus` and a proposer to `claude-cli/sonnet`. To make it explicit
and stage-granular:

7. **Pin exact model IDs.** The `--model` flag (`lib/cli.ts:225`) is passed through
   verbatim, so replace the fuzzy aliases with exact IDs to avoid drift:
   - Sonnet 5 → `claude-sonnet-5`
   - Opus 4.8 → `claude-opus-4-8`

   (`"default"` still means "omit `--model`, let the CLI choose".)

8. **Add an optional per-stage override map** to `FuseConfig` in `lib/types.ts`:

   ```ts
   // optional; when a stage key is present it overrides the role default
   stageModels?: Partial<Record<StageKey, ModelRef>>;
   ```

   Keep it optional and have `mergeConfig` (`lib/types.ts:87`) default it to `{}` so all
   existing stored configs load unchanged.

9. **Resolve stage models through the override.** In `runPlan` (`lib/plan.ts:320`), add a
   resolver and use it in every `makeStage(...)` and at each `callModel` site:

   ```ts
   const roleFor: Record<StageKey, ModelRef> = {
     clarify: a, draftA: a, draftB: b, harden: b,
     recon: aggregator, verify: aggregator, synthesize: aggregator, finalize: aggregator,
   };
   const modelFor = (key: StageKey): ModelRef => config.stageModels?.[key] ?? roleFor[key];
   ```

   Example config for "recon runs Opus 4.8, drafting runs Sonnet 5":

   ```jsonc
   "stageModels": {
     "recon":      { "provider": "claude-cli", "model": "claude-opus-4-8" },
     "verify":     { "provider": "claude-cli", "model": "claude-opus-4-8" },
     "synthesize": { "provider": "claude-cli", "model": "claude-opus-4-8" },
     "draftA":     { "provider": "claude-cli", "model": "claude-sonnet-5" },
     "draftB":     { "provider": "claude-cli", "model": "claude-sonnet-5" }
   }
   ```

10. **Keep session reuse intact.** `recon` chains `recon → verify → synthesize` in one
    resumed Claude session (`lib/plan.ts` recon branch; see `--resume` at `lib/cli.ts:232`).
    A resumed session **cannot switch models mid-thread**, so validate that all three
    chained stages resolve to the **same** `ModelRef`; if `stageModels` sets them
    differently, either fall back to the aggregator model for the whole chain or break the
    chain (drop `--resume`). Surface this as a settings warning rather than a silent break.

---

## Risks & mitigations

- **Token still fails after inject.** If a spawned `claude -p` still reports not-logged-in
  with the token set, the token is expired/revoked — re-run `claude setup-token`. The new
  auth probe (step 4) makes this diagnosable instead of a 20 KB error blob.
- **Token leakage.** `CLAUDE_CODE_OAUTH_TOKEN` is a subscription credential. Store it with
  the same care as an API key: server-side only, redact in logs, never return it to the
  client after save. Prefer OS keychain/`safeStorage` in the Electron layer if available.
- **Model-switch inside a resumed session (recon).** Handled by step 10 — enforce a single
  model across the recon chain.
- **Exact IDs go stale.** `claude-opus-4-8` / `claude-sonnet-5` are current; if a stage
  errors with an unknown-model message, fall back to the `opus`/`sonnet` alias. Consider a
  small allow-list validated against `claude --model ... ` at save time.
- **Codex path untouched.** All changes are scoped to `runClaude` / Claude config; Codex
  stages (which already work) must not receive `CLAUDE_CODE_OAUTH_TOKEN` or the new model
  IDs.

## Testing

1. **Reproduce (before):** run any `relay` plan → confirm the current
   `Not logged in · Please run /login` on every `claude-cli` stage.
2. **Unit — env:** assert `childEnv()` includes `CLAUDE_CODE_OAUTH_TOKEN` when the token is
   configured and **omits** it when it isn't; assert Codex spawns never include it.
3. **Auth probe:** with a valid token, `detectClis()` reports Claude `ok:true, loggedIn:true`;
   with the token cleared, it reports `ok:true, loggedIn:false` (found but unauthenticated) —
   verifying the gap that let the setup gate pass a broken state.
4. **End-to-end (after):** re-run the same `relay` and `recon` prompts from your debug
   output; every `claude-cli` stage now returns real content and token usage, `4 errors → 0`.
5. **Per-stage models:** set the `stageModels` example above, run `recon`, and confirm in
   the pipeline debug view that the recon/verify/synthesize stage labels show
   `claude-opus-4-8` and the draft stages show `claude-sonnet-5`.
6. **Recon chain guard:** set conflicting `stageModels` for `recon` vs `verify`; confirm
   the settings warning fires (or the chain cleanly falls back to one model) rather than a
   mid-session model-switch error.
7. **Regression:** load a pre-existing stored config with no `stageModels`/`claudeOauthToken`
   and confirm `mergeConfig` loads it unchanged and the pipeline still runs.
