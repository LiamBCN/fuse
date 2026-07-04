# Plan: Remaining Items After the Fast/Deep Consolidation

Status audit of `PLAN-two-mode-consolidation.md` (implemented 2026-07-02), plus the concerns the re-benchmark judging surfaced. Flat list — no phases; every item is independently shippable.

## What is already done and verified

- Two modes shipped: **Fast** (drafts ∥ → grounded verify-finalize, 3 calls) and **Deep** (clarify screen → recon → drafts ∥ → verify → synthesize, with recon/verify/synthesize as three turns of ONE resumed claude session). `Mode = "normal" | "fast" | "deep"` with full legacy migration (relay→fast; recon/relay2/attack→deep).
- Session plumbing: `--session-id`/`--resume` + `session_id` extraction (`lib/cli.ts`), `CliSession` threading (`lib/providers.ts`), chain fallback to fresh calls if a resume fails. Verified at transcript level: one session file contains RECON → VERIFY-resumed → SYNTH-resumed.
- Codex `--json`: real token usage (replaces `len/4` estimates) + resumable `thread_id` captured; per-call `reasoningEffort` plumbing exists.
- Robustness: retry-once + visible WARNING header when a closing stage dies (no more silent unverified-draft fallback); brief now included in verify's fallback path; draft-stage heartbeats; per-stage progress throttle; clarify pre-check before Deep's recon; `planSlug` handles `## Goal`-first plans; per-run file-diff excludes other runs' plan files (proven by the overlapping fast/deep runs — zero cross-attachment).
- UI: Normal/Fast/Deep picker + blurbs, tooltip fixed, folder default → deep, pipeline explainer reflowed, debugDump infers fast/deep with legacy branches kept, orphaned plan-attack/plan-relay images deleted.
- Quality gate: `tsc --noEmit` and full `next build` green. Re-benchmark with blind judging: **deep 9.075 and fast 9.025 both beat every old mode (best baseline: relay 8.93)**; zero fabrications; fast 10m07s (target ≤11m met), deep 18m04s (beats old recon's 20m07s; the aspirational ≤16m target was missed by ~2m).
- Harness formalized: `scripts/bench-plan-modes.sh` + `scripts/bench/` (prompt, extractor, gitignored `out/`).

## Remaining items

1. **Strengthen Fast's QA grounding (the one quality miss).** Fast's plan still hit rubric trap 7: its E2E test asserted a draft-articles flow the target code cannot run — exactly what `QA_NOTE` was added to prevent (it worked for Deep, which has a dedicated verify stage; Fast's single combined stage under-enforced it). Edit `FAST_FINAL_SYS` in `lib/plan.ts`: add an explicit bullet to the VERIFY-BEFORE-YOU-ADOPT paragraph — "treat every end-to-end Testing step as a claim set: before asserting a user-visible flow works today, confirm each leg of it in the code, and if any leg does not exist, convert the step into 'first verify…' or tie it to the implementation step that creates it." Cheap prompt change, no code.

2. **Add a requirement-coverage rule to both closing prompts.** Deep passed QA by *silently omitting* an entire numbered requirement (the draft workflow) rather than addressing it. Append to `FAST_FINAL_SYS` and `RECON_SYNTH_SYS`: "Enumerate every numbered/bulleted requirement in the request and cover each in the plan; if you intentionally exclude one (out of scope, impossible today, needs a product decision), say so explicitly under Risks & mitigations with the reason — never drop a requirement silently." Directly fixes the only coverage gap either new mode showed.

3. **Validate the five plan sections before accepting a final.** Today the retry fires only on an *empty* closing stage (`lib/plan.ts` fast/deep branches). Treat a final missing any of the five required `## ` sections as failed too: add a small `hasPlanSections(md)` helper (checks the 5 headings) and use it in the retry condition and the `degraded` check. Prevents a malformed half-plan from shipping without the WARNING header.

4. **Honor `planMode` for codex (`lib/cli.ts:304`).** `_planMode` is still unused: with a codex aggregator configured, plan-mode verify/finalize stages would run `--sandbox workspace-write` and could edit source (the "plan files only" rule is prompt-only for codex). Fix: in `runCodex`, when `planMode && scoped`, keep `workspace-write` (drafts legitimately write scratch notes) but pass planMode down so a future non-draft codex stage can request `read-only`; minimally, add a `CliOpts.sandbox` override and set `read-only` from `runPlan`'s aggregator calls when the provider is codex. Low urgency (default config never routes codex to those stages) but closes a real hole for custom configs.

5. **Guard the deprecated `--max-turns` flag (`lib/cli.ts:223,227,240`).** It vanished from `claude --help` in 2.1.198 but still works. Add a one-shot fallback in `runClaude`: if the spawn fails fast with an unknown-option error mentioning `--max-turns`, retry once without those two args. Three-line insurance against the next CLI update breaking every plan run.

6. **Two-concurrent-Deep sanity check.** The overlapping fast+deep runs already proved session and file isolation; the one untested combination is two Deep runs at once (two pinned session UUIDs on the same folder). Run: `./scripts/bench-plan-modes.sh deep & ./scripts/bench-plan-modes.sh deep` against a small fixture folder and confirm both chain their own sessions (two distinct `RECON → VERIFY-resumed → SYNTH-resumed` transcript files). Expected to pass (UUIDs are random); this is a 15-minute confidence check, not a code change.

7. **Deploy the packaged app.** The Mac app on :3030 still runs the OLD pipeline (all benchmarks of the new code ran on a dev server). Ship via the existing stable-cert deploy flow (~5 min) when you say the word — after that, the app's mode menu shows Normal/Fast/Deep and stored configs migrate automatically on first load.

8. **Commit the working tree.** Everything is uncommitted (8 modified files, deleted images, new `scripts/bench/` + plan docs). Suggested split: (a) pipeline + runtime (`lib/*`, `app/*`), (b) benchmark harness (`scripts/*`, `.gitignore`), (c) plan docs. Say the word and I'll commit.

9. *(Optional)* **Per-stage codex reasoning effort.** Plumbing exists (`CallArgs.reasoningEffort`) but every stage still runs `medium`, which benchmarked fine. If you want to experiment: drafts `high`, everything else `medium` — then re-run `scripts/bench-plan-modes.sh` before trusting it (higher effort = slower; the idle timeout is streaming-safe).

10. *(Optional)* **Session-file hygiene.** Resumable sessions now require persistence, so `~/.claude/projects/<folder>/*.jsonl` files accumulate per plan run (~1 MB each). If it ever bothers you: a small cleanup in the app's maintenance path deleting session files older than ~14 days. Do NOT disable persistence — resume depends on it.

11. *(Optional)* **Hover diagrams for Fast/Deep.** The mode menu shows a hover preview only for Normal (`plan-normal.png`); Fast/Deep have none since the old images were deleted. Either export two small diagrams (`plan-fast.png`, `plan-deep.png`) mirroring the pipeline-page flows, or remove the hover preview entirely for consistency.

12. *(Optional)* **Deep wall-time trim toward the 16-minute target.** Deep is already faster and better than old recon; if the last ~2 minutes matter, the two candidate levers are: tighten `RECON_SYS`'s reading budget (it front-loads the biggest stage), or fan the verify stage per-draft using `--fork-session` off the recon session (two parallel single-draft verifiers that both inherit recon's context). Only pursue after item 6; re-benchmark either way.

## Out of scope of this plan (tracked elsewhere)

- **The Migma access-control feature itself** is still unimplemented — the benchmark produced a recommended blueprint (Deep's plan, `fuse-plan-add-three-internal-admin-panel-roles-on-top-of-the-20260702-013051.md` in `/Users/liam/migma-both`), judged 9.075 with zero traps. Note before executing it: every judged plan left the draft-articles workflow unbuilt (the editor hardcodes `published: true`), so add that requirement back when implementing.
- UX-critic skill plan (`PLAN-ux-critic-skill.md`) — separate effort, untouched by this work.

## Verification (for any item above that changes code)

```
npx tsc --noEmit && npx next build
npx next dev -p 3031   # then:
./scripts/bench-plan-modes.sh fast --url http://127.0.0.1:3031
./scripts/bench-plan-modes.sh deep --url http://127.0.0.1:3031
```
Judge the resulting plans against `scripts/bench/prompt-migma.txt`'s rubric flow before deploying; acceptance = no fabrications, overall ≥ the 9.0 the new modes just scored.
