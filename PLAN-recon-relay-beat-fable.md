# Plan: Make Relay and Recon better AND faster than solo Fable

Benchmark: run `6667b959` (migma-author-location-fields, 7/4/2026, 1 judge × 1 pass × 1 rep):

| Contender | Score | Time | Tokens |
|---|---|---|---|
| claude-fable-5 · solo | 66.7% | 2m39s | 746k |
| recon | 64.1% | 5m49s | 1.29M |
| relay | 46.2% | 2m46s | 965k |

Every code reference below was re-verified against `lib/plan.ts` (905 lines) and `lib/cli.ts` on 7/4. Supersedes `PLAN-modes-beat-solo-fable.md` (same diagnosis, but this plan adds a hard wall-clock budget so both modes actually undercut Fable's 2m39s, not just its score).

## Goal

Relay and recon each beat solo Fable on **both axes** of this benchmark class:

- **relay**: ≥ 70% checklist, ≤ 2m20s wall clock, zero degraded (WARNING-banner) outputs.
- **recon**: ≥ 70% checklist, ≤ 2m40s wall clock, ≥ 30% token cut (1.29M → ≤ 900k).

Three change families get us there: (1) fix relay's failure plumbing — its 46.2% was a pipeline bug, not a model gap; (2) close recon's two scoring loopholes (wrong-surface anchoring, requirement demotion); (3) restructure both pipelines' serial hops so wall clock ≈ draft time + one short closing stage.

## Diagnosis (what the benchmark actually showed)

### Relay 46.2% — shipped a WARNING banner + one line of tool narration. Three compounding bugs:

1. **Harden runs blind and tool-less but doesn't know it.** The harden call passes no `workdir` ([plan.ts:723-733](lib/plan.ts:723)), and unscoped claude runs get `--tools "" --permission-mode default --max-turns 40` ([cli.ts:328](lib/cli.ts:328)). Nothing in `HARDEN_SYS` ([plan.ts:129](lib/plan.ts:129)) says "you have no file access", so the model emitted `ls -la …` narration instead of a plan, and `hardened = hard.content?.trim() || da.content` ([plan.ts:740](lib/plan.ts:740)) accepted it.
2. **`FINAL_SYS` has no output contract** ([plan.ts:133-136](lib/plan.ts:133)). Unlike `FAST_FINAL_SYS` and `RECON_SYNTH_SYS` it never demands the five sections nor "first characters must be `## Goal`", so finalize output fails `hasPlanSections()` ([plan.ts:266](lib/plan.ts:266)), burns the retry ([plan.ts:755-768](lib/plan.ts:755)), and degrades anyway.
3. **The degraded fallback prefers the garbage**: `final = hardened || da.content || db.content` ([plan.ts:777](lib/plan.ts:777)) ships harden's narration over two real grounded drafts. fast and recon guard with `bestDraftFallback()` ([plan.ts:279](lib/plan.ts:279)); relay is the only mode that doesn't.

Zero wrong claims, zero fabrications — relay lost purely on plumbing. Note the 2m46s **includes a wasted finalize retry**; the same run without the failure loop is already near ~2m10s.

### Recon 64.1% — right facts, wrong anchor, trimmed scope, 2.2× Fable's wall clock

- **Wrong surface.** The request named "admin panel inside the blog administration page"; recon's brief anchored everything on the standalone `/admin/authors` dialog, and the judge docked exactly that. Fable enumerated all three duplicated author dialogs and led with the named one. Nothing in `RECON_SYS` ([plan.ts:147-162](lib/plan.ts:147)) asks for the *named* surface or for duplicated implementations of the same UI.
- **Requirement demotion.** Recon left the article byline "untouched" and made JSON-LD "optional polish, not shipped by default". `REQUIREMENT_COVERAGE_NOTE` ([plan.ts:101](lib/plan.ts:101)) forbids silent drops but permits demoting to optional — a loophole the checklist punished.
- **Serial chain.** clarify → recon → drafts∥ → verify → synthesize: 4 serial hops after the screen ([plan.ts:538-879](lib/plan.ts:538)). The resumed-session trick saves tokens but overlaps nothing in wall clock.

### Judge-reliability caveat

1 judge × 1 pass × 1 rep, ±0.0% spread — the 2.6-point Fable-vs-recon gap is ~one checklist item and not significant alone. Relay's 46.2% **is** real (structurally broken output). Any before/after claim needs ≥3 reps × ≥2 judge passes (gate in Testing).

## Wall-clock budget (how each mode gets under 2m39s)

Anatomy: drafts run in parallel and dominate (~1.5–2m). Every serial hop after them is pure overhead.

| Mode | Today | Change | Target shape | Est. |
|---|---|---|---|---|
| relay | drafts → harden → finalize (+retry) = 3–4 hops | merge harden+finalize into ONE blind stage; kill the retry-by-default via output contract | drafts∥ → harden-finalize | ~2m0s–2m20s |
| recon | clarify → recon → drafts → verify → synthesize = 5 hops | clarify ∥ recon ∥ drafts; merge verify+synthesize into one resumed turn; tighter recon budget | (clarify ∥ recon ∥ drafts) → verify-synthesize | ~2m20s–2m40s |

Supporting levers, all already plumbed: per-call `reasoningEffort` exists end-to-end ([providers.ts:45](lib/providers.ts:45), [cli.ts:296](lib/cli.ts:296)) but `call()` in plan.ts never passes it — blind text-only stages can run at `medium` effort for speed; resumed sessions ([cli.ts:303-304](lib/cli.ts:303)) make the recon closer cache-warm instead of cold.

## Affected files

- [lib/plan.ts](lib/plan.ts) — edit (all prompt + orchestration changes live here).
- `lib/plan.test.ts` — NEW: unit tests for the fallback guard and `hasPlanSections`.
- No changes to `lib/cli.ts`, `lib/providers.ts`, `lib/types.ts` (relay's stage keys shrink but `StageKey` already contains every key used; recon's `total` constant updates inside plan.ts:448).
- [app/pipeline/page.tsx](app/pipeline/page.tsx) + mode blurbs in [app/page.tsx](app/page.tsx) — edit: reflect the new stage shapes (relay 3 nodes, recon overlapped).

## Implementation steps

### A. Shared prompt fixes (both modes + fast)

1. **Close the demotion loophole** in `REQUIREMENT_COVERAGE_NOTE` (plan.ts:101). Append: *"A location the request names (a specific page, screen, dialog, or flow) is itself a requirement — change that exact surface, not a similar one elsewhere. Demoting a requested behavior to 'optional', 'polish', or 'skip unless requested' counts as dropping it: ship it by default or justify the exclusion under Risks & mitigations."*
2. **Add `SURFACE_NOTE`** next to `QA_NOTE` (plan.ts:98): *"SURFACE TARGETING: when the request names a UI location, first locate that exact surface and cite it. Then enumerate EVERY duplicated implementation of the same UI (repos often carry 2–3 copies of the same dialog/form) and cover each or explicitly scope it out — never silently patch only one copy."* Append to `DRAFT_SYS` (plan.ts:85), `RECON_SYS` (plan.ts:147), `FAST_FINAL_SYS` (plan.ts:112), and the new closing prompts below. This is the exact checklist point recon lost and the thing Fable did unprompted.

### B. Relay — un-breakable and 3 calls

3. **Guard the degraded fallback** (plan.ts:777): replace `final = hardened || da.content || db.content` with `final = hasPlanSections(hardened) ? hardened : bestDraftFallback(da.content, db.content)`. This alone turns the benchmark's 46.2% into a real (WARNING-prefixed) plan.
4. **Merge harden + finalize into one blind stage** (`HARDEN_FINAL_SYS`, replacing plan.ts:717-785's two calls with one + retry):
   - Identity: *"You harden and finalize in one pass: fold the stronger content of plan [B] into plan [A], fix risks and missing steps, and output the final implementation-ready plan."*
   - **Blindness clause**: *"You have NO access to files, tools, or a shell — never output commands, tool narration, or requests to inspect the repo. Work strictly from the plan texts; treat their file references as given."* (Fixes bug 1; blind stages stay blind by design — that's relay's identity and its speed.)
   - **Output contract**: exact five sections in order, *"your VERY FIRST characters must be `## Goal`"*, no meta-commentary — copied from `FAST_FINAL_SYS` (plan.ts:119-125) — plus `QA_NOTE` + `REQUIREMENT_COVERAGE_NOTE` + `SURFACE_NOTE`. (Fixes bug 2; the retry becomes a rare event instead of the norm.)
   - Pick the primary draft by quality, not position: `hasPlanSections(da.content) ? [A=da, B=db] : [A=db, B=da]`.
   - Pass `reasoningEffort: "medium"` for this stage (thread `reasoningEffort` through plan.ts's `call()` into `callModel` — the field already exists in `CallArgs`). Text-only merge doesn't need `high`, and it buys ~20–40s.
   - Keep the single retry + `bestDraftFallback` degrade path. Stage list (plan.ts:387-393) becomes draftA/draftB/finalize; `total` for relay 4 → 3 (plan.ts:448).

### C. Recon — fix coverage, then collapse 5 hops to 2

5. **Brief must map the named surface.** Add a mandatory heading to `RECON_SYS`'s output spec (after "Integration points", plan.ts:157): *"- Named surfaces: the exact file/component implementing each page/dialog/flow the request names, plus every duplicated implementation of that UI (grep for shared labels/components) — one line each with path:line."*
6. **Forbid demotion at synthesis.** In `RECON_SYNTH_SYS`'s proportionality sentence (plan.ts:187), add the counterweight: *"Proportional cuts must never remove or optional-ize something the request explicitly asked to see — every requested display surface ships by default."*
7. **Overlap clarify ∥ recon ∥ drafts** (the big wall-clock win, ~2–2.5m):
   - Start recon and both drafts simultaneously; drafts drop `briefBlock` from `draftInstruction` (plan.ts:623) — they keep `workdir` and explore on their own exactly like fast mode's drafts. This run proved brief-seeded drafts still anchored on the wrong dialog, so seeding wasn't buying accuracy; steps 2+5 are the real remedy, applied where the brief is actually consumed (the closer).
   - Run the clarify screen concurrently too: if it returns questions, `ac.abort()` the in-flight recon/drafts and return `clarifyResult` (abort plumbing already exists, plan.ts:316-323). Wasted spend on a clarify hit is bounded and rare; the serial hop it removes is paid on every run.
8. **Merge verify + synthesize into one resumed turn** (`RECON_FINAL_SYS`, replacing plan.ts:787-879): resume the recon session (files already in context) with: fact-check both drafts against the code you already read — carry `VERIFY_SYS`'s vocabulary verbatim (*"a draft asserting something is NOT evidence — the file is"*, FABRICATED/WRONG/MISSING/UNNECESSARY) — then output ONLY the final plan with every correction applied. Same output contract + notes as `FAST_FINAL_SYS`. Keep the fresh-call fallback (re-fence brief + drafts) and the `hasPlanSections` retry/degrade → `bestDraftFallback` logic. Stage list (plan.ts:394-401) becomes clarify/recon/draftA/draftB/finalize; `total` 5 → 4; update the header comment (plan.ts:6-11). We lose the standalone "# Corrections report" debug artifact — acceptable; the old `VERIFY_SYS` stays in the file for per-stage-override experiments.
9. **Tighten recon's budget**: `RECON_SYS` tool budget ~40 → ~25 calls and add *"the brief must fit in ~150 lines"*. Recon no longer feeds drafts (step 7), so it only needs to arm the closer — a tighter brief is a feature. Net shape: **(clarify ∥ recon ∥ drafts) → verify-synthesize(resumed)** ≈ max(recon, drafts) + one cache-warm closing stage.

### D. Bench validation

10. Add relay + recon (new shapes) + fast + solo fable to the next bench run: same snapshot `migma-author-location-fields` **plus ≥1 other task**, ≥3 reps, ≥2 judge passes (this run's 1×1×1 can't resolve a 2.6-point gap).

## Risks & mitigations

- **Merged blind stage weaker than harden→finalize (B4).** Two blind hops over the same text mostly re-read each other; the merged prompt keeps both mandates. Bench gate (step 10) decides; if relay regresses on score, re-add the second hop — we still keep bugs 1–3 fixed.
- **Unseeded drafts regress recon quality (C7).** Drafts keep full repo access — identical grounding to fast mode's drafts, and this run shows seeding didn't prevent the wrong-surface miss. If reps show draft regression, revert C7 alone (isolated ordering change) and keep C8's savings.
- **Merged verify-synthesize under-fact-checks (C8).** Mitigation: adversarial vocabulary carried verbatim; resumed session means the checker already holds the ground truth it needs; bench with ≥3 reps before deleting `VERIFY_SYS` (we don't delete it).
- **Clarify-abort races (C7).** A clarify hit aborts in-flight stages mid-stream; `assertNotStopped()`/`RunStoppedError` paths already handle sibling aborts (plan.ts:433-437) — reuse, don't invent. Verify the stage UI shows skipped (not error) states in this path.
- **Effort override changes closing-stage character (B4).** Only relay's blind merge drops to `medium`; grounded stages keep the configured effort. One-line revert if bench disagrees.
- **Overfitting to one checklist.** A1/A2 encode general failure classes (named-surface targeting, requirement demotion); validation uses ≥2 tasks.

## Testing

1. `npx tsc --noEmit`.
2. **Unit (NEW `lib/plan.test.ts`)**: (a) relay degrade path: `hasPlanSections`-failing hardened text + valid draft ⇒ draft ships with WARNING banner, narration does not; fixture = this run's actual relay output (warning + `ls -la` fragment). (b) `hasPlanSections` accepts a `## Goal`-first plan, rejects the fixture.
3. **Smoke**: one recon run on a small repo — stage UI shows recon and drafts streaming simultaneously, resumed closer fires (`rec.sessionId === pinned`, plan.ts:592), plan file has five sections. One relay run — three stages, no retry on a normal pass.
4. **Bench gate (the real one)**: step 10's matrix. Success = relay ≥70% & ≤2m20s & zero degraded outputs across all reps; recon ≥70% & ≤2m40s & ≤900k tokens; neither below solo Fable on any rep's score.
