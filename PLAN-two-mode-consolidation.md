# Plan: Two-Mode Consolidation + Session-Reuse Runtime for Fuse Plan Mode

## Goal

Replace the three plan modes (recon / relay / relay2) with **two** clearly differentiated modes — **Fast** (speed) and **Deep** (power) — and rebuild the pipeline runtime so stages stop re-exploring the repo from scratch: aggregator stages share **one resumable CLI session**, verification checks *claims* instead of re-reading the tree, and QA sections are grounded in current behavior. Target: Deep produces recon-or-better quality at ~40% fewer tokens and ~25% less wall time; Fast keeps relay's quality at 3 stages instead of 4.

## Evidence (why these changes, in this order)

Benchmark: identical complex prompt (role-based admin panel for Migma) run through all three modes against `/Users/liam/migma-both` via the live app on :3030, judged blind by 9 agents (fabrication / rubric coverage / implementability) against a repo ground-truth rubric.

| | relay | recon | relay2 |
|---|---|---|---|
| Overall score | **8.93 (1st)** | 8.27 | 7.93 |
| Grounding (wrong claims) | 9/10 (1) | 8/10 (2) | 7/10 (3) |
| Fabrications | 0 | 0 | 0 |
| Wall time | 14m45s | 20m07s | 20m56s |
| Total tokens | 1.28M | 3.89M | 2.71M |

Findings that drive the design:
1. **Zero fabrications in every mode** — grounded drafting (drafts always run with `workdir`) already killed the hallucination failure mode. The extra grounded stages are no longer what prevents fabrication.
2. **The expensive stages re-buy the same work.** Every stage is a cold `spawn()` (`lib/cli.ts:117`); recon's 846k-token investigation is thrown away, then draft A (1.86M), verify (881k), and synthesize re-read the same files. Nothing persists across stages — no tool results, no prompt cache.
3. **Verify is starved of its best input.** In recon mode the verifier never receives the brief (`lib/plan.ts:351-357`) and re-Greps signatures the brief already quotes verbatim.
4. **The shared failure was unverified QA.** All three plans asserted a "blog user drafts an article" test that cannot pass (the real editor hardcodes `published: true`). Verification stages that check the plan's own claims paid off; QA text generated from requirements did not.
5. **Session reuse is available today.** claude 2.1.198: `--session-id <uuid>` (pre-assign), `--resume <uuid>`, `--fork-session`, all in `-p` mode. The CLI's final `result` event includes a `session_id` field (verified against the live CLI); Fuse already parses that event (`lib/cli.ts:259-269`) but does not extract the field yet — Phase 1 adds that. codex 0.142.5: `codex exec resume <SESSION_ID>`. Resumed sessions replay the transcript **including tool results**, so files read in an earlier stage are remembered.
6. Misc confirmed defects: silent fallback to unverified drafts (`final = syn.content || da.content || db.content`, `lib/plan.ts:376,416,444`); codex usage is `length/4` estimates (`lib/cli.ts:326-330`) so mode stats are incomparable; codex reasoning effort hardcoded `medium` for all roles (`lib/cli.ts:306`); codex ignores `planMode` and gets `workspace-write` in plan mode (`lib/cli.ts:289,303`); drafts stream no heartbeat (`lib/plan.ts:311-322`); `@@CLARIFY@@` detectable only after recon already ran (`lib/plan.ts:328-343`); `planSlug()` can't title `## Goal`-first plans so filenames fall back to raw request text (`lib/plan.ts:206-217`); concurrent runs sharing a workdir cross-attach each other's plan files via the before/after diff (`lib/plan.ts:249-250,456-459`); `--max-turns` still works but vanished from claude's `--help` (deprecation risk).

## The two modes

### Fast — "two agents draft, the lead verifies and finalizes" (3 calls, 2 sequential hops)
```
draft A (sonnet, grounded) ∥ draft B (codex, grounded)
        → verify-finalize (opus, grounded, ONE stage)
```
- Replaces relay (winner) and relay2. Keeps what made relay win — strong grounded drafts + a conservative Opus final pass — but makes the final pass *grounded with a fact-check mandate*: a merged `FAST_FINAL_SYS` that (a) spot-checks each draft's load-bearing claims (files/symbols/endpoints) with targeted Read/Grep before adopting them, (b) merges the stronger draft content, (c) applies the QA-grounding rule (below). One stage instead of harden+finalize: drops ~4-6 min and one cold start.
- UI blurb: "Fast — two agents draft from your real code; the strongest model fact-checks the load-bearing claims and finalizes. ~10-15 min."

### Deep — recon pipeline on one shared session (5 calls, 4 sequential hops, but 3 share a session)
```
recon (opus, session S, --session-id <uuid>)
  → draft A (sonnet, fresh) ∥ draft B (codex, fresh)   [seeded with brief]
  → verify (opus, --resume S)      [gets brief + drafts; files already in context]
  → synthesize (opus, --resume S)  [gets corrections; everything in context]
```
- Same shape as recon (the structure is sound) but recon → verify → synthesize become three turns of **one** claude session: the verifier already holds every file recon read, so its ~40-tool-call budget goes entirely to checking *draft claims the brief doesn't settle*; synthesis pays cache-read prices for the brief/drafts/corrections instead of fresh input. Expected: verify+synth drop from ~1.1M fresh-ish tokens to a fraction, and two cold starts disappear.
- Drafts stay **fresh sessions on purpose** — independence is their value; they're seeded with the brief text as today.
- UI blurb: "Deep — one model recons your code first, two agents draft from that brief, then verification and synthesis run in the recon session so every claim is checked against files already in context. Slower, maximum-confidence plan."

### Retirements and migration
- `relay` and `relay2` retire as selectable modes. `Mode` union becomes `"normal" | "fast" | "deep"`; `PlanMode = "fast" | "deep"`.
- `mergeConfig` migrations: `relay → fast`, `relay2 → deep`, `recon → deep`, legacy `attack → deep`. Folder auto-upgrade (`lib/types.ts:82`) becomes `normal → deep`.
- Keep `debugDump()`'s legacy label-inference branches in `app/page.tsx` (old transcripts still mention harden/recon labels).

## Affected files

- `lib/types.ts` — edit: `Mode` union (:38), `PlanMode` (:42), doc comment (:33-37), `DEFAULT_CONFIG` (:65 stays "normal"), `mergeConfig` migrations (:76-82).
- `lib/plan.ts` — edit (largest): pipeline branches, new `FAST_FINAL_SYS`, session threading, verify gets the brief, QA-grounding prompt additions, fallback surfacing, clarify pre-check, `planSlug` `## Goal` handling, per-run file-diff filter, drafts heartbeat, per-stage `lastEmit`.
- `lib/providers.ts` — edit: `CallArgs` gains `session?: { id?: string; resume?: string }` and per-call `reasoningEffort?: "low"|"medium"|"high"`; return type gains `sessionId?: string`.
- `lib/cli.ts` — edit: `runClaude` adds `--session-id` / `--resume` args and returns `data.session_id`; `runCodex` gains `--json` usage parsing, per-call reasoning effort, and honors `planMode` (read-only sandbox for non-draft stages); keep `--max-turns` but detect "unknown option" stderr and retry without it once.
- `app/page.tsx` — edit: `MODE_OPTIONS` (:32-55) → Normal / Fast / Deep with fresh blurbs; stale "Attack/Relay" tooltip (:765); hover images (add `plan-fast.png`/`plan-deep.png` or drop the hover preview); `selectFolder` default `"deep"` (:311); mode filter unchanged.
- `app/pipeline/page.tsx` — edit: rename variants recon→Deep, relay2→Fast; `Relay2Flow` becomes the 3-node Fast flow; update the `why` copy that name-drops old Relay.
- `app/api/chat/route.ts` — no logic change (mode is a pass-through type).
- `public/plan-relay.png`, `public/plan-attack.png` — delete or replace with the two new pipeline images.
- NEW `scripts/bench-plan-modes.sh` + `scripts/bench/` — formalize the benchmark harness used for this evaluation (prompt file, SSE runner against :3030, result extractor) so any pipeline change can be re-scored on the same Migma prompt before shipping.

## Implementation steps

**Phase 1 — runtime plumbing (no behavior change yet)**
1. Thread `session` through `CallArgs` → `runCli` → `runClaude`: when `session.id` set, append `--session-id <id>`; when `session.resume` set, append `--resume <id>`; never pass `--no-session-persistence`. Parse `session_id` from the final `result` event (already parsed at `lib/cli.ts:259-269`) and return it in `CallResult`.
2. Add codex `--json` event parsing in `runCodex` to capture real token usage (fall back to `len/4` if absent) and the thread/session id; add `reasoningEffort` arg mapped to `-c model_reasoning_effort=...`.
3. Honor `planMode` for codex: non-draft plan stages run `--sandbox read-only`; drafts keep `workspace-write` (they may write scratch notes).
4. Fallback surfacing: in `runPlan`, when a `||` fallback fires (empty synth/finalize), retry that stage once; if still empty, prepend a visible `> ⚠ Verification stage failed; this plan is an unverified draft.` header to the written plan and say so in the progress label.
5. Drafts heartbeat: pass `makeActivity` per-agent into the two draft calls; make `lastEmit` per-stage.

**Phase 2 — the two pipelines**
6. Implement `fast`: parallel grounded drafts → single `FAST_FINAL_SYS` opus stage (grounded, `workdir`), with the claim-spot-check + merge + QA-grounding mandates. Stage math: total = 3.
7. Implement `deep`: recon with a pre-generated UUID session; verify and synthesize with `--resume` on that UUID. Verify instruction now includes the brief (as `briefBlock`). If a resume call errors, fall back automatically to today's fresh-spawn + full re-paste behavior for that stage (graceful degradation, log it in the proposal record).
8. QA-grounding rule added to `VERIFY_SYS`, `FAST_FINAL_SYS`, and the synth prompts: "In Testing, every step asserting current behavior must cite where that behavior lives; write 'verify that X currently does Y' checks for anything the plan depends on but did not change. Never state an expectation the current code cannot satisfy — flag it as a required change instead." (This is the trap-7 class fix: all three benchmark plans shipped untestable QA.)
9. Clarify pre-check: before recon, run `extractQuestions` on a single cheap tool-less claude call ("Does this request need clarification a codebase can't answer? Reply @@CLARIFY@@ [...] or NO.") — skip recon spend when questions exist.
10. `planSlug`: when no H1, derive the slug from the first line under `## Goal`; keep the request fallback. Per-run file diff: exclude `fuse-plan-*.md` files not equal to this run's `planPath` (fixes concurrent-run cross-attachment).

**Phase 3 — UI + types**
11. `lib/types.ts` union + `mergeConfig` migrations as above; update mode doc comment.
12. `app/page.tsx` `MODE_OPTIONS` → Normal / Fast / Deep with the blurbs above; fix the stale tooltip; `selectFolder` upgrades normal→deep.
13. `app/pipeline/page.tsx`: two variants with the new names/flows; refresh copy.

**Phase 4 — verification**
14. `tsc` + full `next build`.
15. Re-run the benchmark harness: same Migma prompt, `fast` and `deep`, same judge rubric. Acceptance: deep ≥ recon's grounding (≥8/10) at ≤2.4M tokens and ≤16 min; fast ≥ relay's overall (≥8.5) at ≤11 min; zero fabrications both.
16. Regression: run one plan in a *fresh* folder with two concurrent chats to confirm session ids don't collide and file-diff attaches only own artifacts.

## Risks & mitigations

- **Resumed-session context growth**: recon's transcript (many file reads) is replayed into verify/synth; on a huge repo this could approach context limits. Mitigation: the CLI compacts automatically; cap recon's brief-stage reading discipline as today; fallback path (step 7) keeps runs alive if resume fails.
- **Fast mode is a recipe change from the benchmark winner** (drops codex harden). Mitigation: step 15 re-benchmarks before ship; if fast regresses, reinstate harden as an optional 4th stage behind the same session mechanics.
- **`--max-turns` deprecation**: undocumented but functional in 2.1.198. Mitigation: step 1's unknown-option retry; longer term, budget via `--max-budget-usd` or turn-driving over stream-json.
- **Stored configs with retired modes**: `mergeConfig` migration covers relay/relay2/recon/attack; `debugDump` keeps legacy inference branches for old transcripts.
- **Codex `--json` shape drift**: parse defensively, keep `len/4` fallback.
- **Session files accumulate on disk** (persistence now required for resume): document; optionally clean `~/.claude` session files older than N days from the app's maintenance path — do not disable persistence.

## Testing

- Unit-ish: a headless runner script (formalized harness, step "scripts/bench-plan-modes.sh") exercising both modes against a small fixture repo; assert 5 sections present, plan file written, no source file modified, `files` contains only own artifacts.
- The full Migma benchmark + blind judging as the quality gate (step 15) — the rubric and judge prompts from this evaluation live with the harness so results are comparable run-over-run.
- Manual: two concurrent chats in the app, one per mode, same folder; confirm distinct sessions, live heartbeats on drafts, and warning header when a stage is forced to fall back.
