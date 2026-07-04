# Plan: Make Fast / Relay / Recon beat solo Fable (post-benchmark fixes)

Benchmark analyzed: run `6667b959` (migma-author-location-fields, 7/4/2026).
Result: **solo claude-fable-5 66.7% / 2m39s / 746k** beat **recon 64.1% / 5m49s / 1.29M** and **relay 46.2% / 2m46s / 965k**. Every change below is grounded in `lib/plan.ts` (905 lines, read in full) and `lib/cli.ts`.

---

## Diagnosis — why each contender lost

### Relay (46.2%) — a reliability failure, not a quality gap

The shipped file was a WARNING banner plus one line of narration ("Checking whether the referenced repo actually exists… `ls -la …/fuse-cli`"). Chain of failure, all visible in the code:

1. **Harden runs blind AND tool-less** (`call(hardenModel, HARDEN_SYS, …, undefined /* no workdir */)` at `lib/plan.ts:723`; unscoped claude runs get `--tools "" --permission-mode default` at `lib/cli.ts:328`). Nothing in `HARDEN_SYS` (`plan.ts:129`) tells the model it has no repo access, so it emitted tool-use narration instead of a plan. `hardened = hard.content?.trim() || da.content` (`plan.ts:740`) happily accepted that narration.
2. **`FINAL_SYS` has no output contract** (`plan.ts:133`). Unlike `FAST_FINAL_SYS` and `RECON_SYNTH_SYS`, it never names the five required sections nor demands "first characters must be `## Goal`" — so even a decent finalize output fails `hasPlanSections()` (`plan.ts:266`), triggers the retry, fails again, and degrades.
3. **The degraded fallback prefers the garbage**: `final = hardened || da.content || db.content` (`plan.ts:777`) takes the harden narration over two real drafts. Fast and recon use `bestDraftFallback()` (which checks sections); relay does not. Two grounded drafts existed and were thrown away.

Judge critique matches exactly: "only an incomplete warning plus a partial shell command, with no usable implementation plan." Zero wrong claims / fabrications — it lost purely on pipeline plumbing.

### Recon (64.1%) — right facts, wrong anchor, trimmed scope, 2.2× slower

Judge: "it targets the standalone `/admin/authors` dialog while the request specifically names the blog administration page; it also limits article display to the author box only."

- **Wrong surface anchoring.** The request named a location ("admin panel inside the blog administration page"). Fable enumerated all three author dialogs (`/admin/blog`, blog-editor-screen, `/admin/authors`) and led with the named one; recon's pipeline anchored on `/admin/authors` only. Nothing in `RECON_SYS` (`plan.ts:147`) asks recon to (a) locate the *exact surface the request names* or (b) enumerate duplicated implementations of the same UI — so the brief anchored the drafts and synthesizer on the first dialog found.
- **Requirement demotion.** Recon's plan left the article byline "untouched" and made JSON-LD `Person.address` "optional polish, not shipped by default." `REQUIREMENT_COVERAGE_NOTE` (`plan.ts:101`) forbids *silently dropping* requirements but permits *demoting* them to optional — a loophole the checklist punished. Fable shipped both by default.
- **Latency/cost.** 5m49s and 1.29M tokens from a fully serial chain: clarify → recon → drafts∥ → verify → synthesize (5 heavyweight calls, 4 serial hops after clarify). The resumed-session trick saves tokens on verify/synthesize but nothing overlaps in wall clock.

### Qualitative comparison (Fable solo vs recon vs relay)

| Dimension | Fable solo | Recon | Relay |
|---|---|---|---|
| Grounding (real paths/lines) | Excellent | Excellent (0 wrong claims both) | n/a — output was not a plan |
| Requirement coverage | All 3 dialogs, byline + author box + JSON-LD shipped | 1 of 3 dialogs, author box only, JSON-LD optional | none |
| Actionability | Ordered steps, exact code snippets | Comparable where covered | none |
| Testing groundedness | Every step cites path or creating step | Same discipline (the QA_NOTE works) | none |
| Scope discipline | Explicit exclusions with reasons | Over-trimmed (demoted asked-for items) | n/a |

Takeaway: the QA/grounding prompts already work (0 wrong claims, 0 fabrications across the board). The remaining gaps are **coverage/anchoring** (recon) and **pipeline robustness** (relay) — plus wall clock everywhere.

### Judge-reliability caveats (read before trusting deltas)

- **1 judge (codex-cli/gpt-5.5), 1 pass, 1 rep, ±0.0% spread** — there is no variance data at all. The 2.6-point gap between Fable (66.7%) and recon (64.1%) is roughly one checklist item and is **not significant** on its own; do not over-tune to it.
- Relay's 46.2% **is** reliable signal: the output is structurally broken (warning + fragment), independent of judge taste.
- Any "after" comparison must run ≥3 reps and ≥2 judge passes, ideally on ≥2 snapshot tasks, before declaring a mode improved.

---

## Goal

Fix relay so it can never ship a non-plan; fix recon's surface-anchoring and requirement-demotion loopholes; cut recon's wall clock from ~5m50s toward ~3m by overlapping stages and merging the two closing stages; position fast (3 calls, already grounded end-to-end) as the "better AND faster than solo" flagship and include it in the next bench run. Targets: relay ≥ its old 8.9-class scores with zero degraded outputs; recon > 66.7% on this checklist at ≤3m30s; fast ≥ 66.7% at ≤ solo's wall clock.

## Affected files

- `lib/plan.ts` — edit only. All changes are stage prompts, one fallback expression, and recon-mode orchestration order.
- `lib/plan.test.ts` — NEW (or extend existing test setup if one exists): unit tests for the relay fallback guard and `hasPlanSections`.
- No changes to `lib/cli.ts`, `lib/providers.ts`, `lib/moa.ts`, `lib/types.ts` (stage keys, call counts per mode stay compatible; recon drops from 5 to 4 counted calls — one constant updated inside `plan.ts:448`).

## Implementation steps

### A. Shared prompt fixes (help all three modes)

- [ ] **A1. Close the "optional polish" loophole** in `REQUIREMENT_COVERAGE_NOTE` (`plan.ts:101`). Append: *"A location the request names (a specific page, screen, dialog, or flow) is itself a requirement — the plan must change that exact surface, not a similar one elsewhere. Demoting a requested behavior to 'optional', 'polish', or 'skip unless requested' counts as dropping it; ship it by default or justify exclusion under Risks."*
- [ ] **A2. Add a `SURFACE_NOTE` const** (new, next to `QA_NOTE` at `plan.ts:98`): *"SURFACE TARGETING: when the request names a UI location, first locate that exact surface and cite it. Then enumerate EVERY duplicated implementation of the same UI (other dialogs/forms/components with the same role — repos often have 2–3 copies) and either cover each or explicitly scope it out; never silently patch only one copy."* Append it to `DRAFT_SYS` (`plan.ts:85`), `RECON_SYS` (`plan.ts:147`), `FAST_FINAL_SYS` (`plan.ts:112`), and `RECON_SYNTH_SYS` (`plan.ts:183`). This is the single highest-leverage quality fix: it is exactly the checklist point recon lost and exactly what Fable did unprompted.

### B. Relay — make it un-breakable (fixes the 46.2%)

- [ ] **B1. Guard the degraded fallback** at `plan.ts:777`. Replace
  `final = hardened || da.content || db.content;` with
  `final = hasPlanSections(hardened) ? hardened : bestDraftFallback(da.content, db.content);`
  This alone would have turned the benchmark's 46.2% into a real (WARNING-prefixed) plan built from the grounded drafts.
- [ ] **B2. Tell blind stages they are blind.** Add to both `HARDEN_SYS` (`plan.ts:129`) and `FINAL_SYS` (`plan.ts:133`): *"You have NO access to the project's files, tools, or shell — do not attempt to read files, run commands, or verify paths, and never output commands, tool narration, or requests to inspect the repo. Work strictly from the plan texts provided; treat their file references as given."* (Unscoped claude runs are tool-less by construction — `lib/cli.ts:328` — the model just doesn't know it.)
- [ ] **B3. Give `FINAL_SYS` the same output contract as the other finalizers**: exact five sections in order, *"your VERY FIRST characters must be `## Goal` — no preamble"*, no meta-commentary, plus `REQUIREMENT_COVERAGE_NOTE`. Without this, `hasPlanSections()` rejects structurally-fine plans and forces the degraded path.
- [ ] **B4. Require the five sections in `HARDEN_SYS` too** (so a hardened plan is a valid fallback candidate for B1 and a well-shaped input to finalize).
- [ ] **B5 (small, optional). Pick harden's primary draft by quality, not position**: at `plan.ts:720`, use `hasPlanSections(da.content) ? da : db` as "Primary plan to harden" instead of always draft A.

### C. Recon — fix coverage, then cut ~2m30s of wall clock

- [ ] **C1. Brief must map the named surface + duplicates.** In `RECON_SYS`'s output headings (`plan.ts:153-160`), add a bullet after "Integration points": *"- Named surfaces: the exact file/component implementing each page or dialog the request names, plus every duplicated implementation of that UI found by grepping for the shared component/labels — one line each with path:line."* (A2's `SURFACE_NOTE` gives the behavior; this gives it a mandatory slot in the brief so drafters inherit it.)
- [ ] **C2. Forbid demotion at synthesis.** In `RECON_SYNTH_SYS` (`plan.ts:183`), the "keep the plan proportional" sentence currently only pushes one direction (don't invent scope). Add the counterweight: *"Proportional cuts must never remove or optional-ize something the request explicitly asked to see — every requested display surface ships by default."* (A1 also lands here via `REQUIREMENT_COVERAGE_NOTE`, already appended at `plan.ts:197`.)
- [ ] **C3. Run drafts in parallel with recon** (biggest wall-clock win, ~1.5–2m). In `runPlanInner`, start the two draft calls at the same time as the recon call instead of after it: kick off the `Promise.all` of drafts (currently `plan.ts:624`) alongside the recon `call` (`plan.ts:574`), and drop `briefBlock` from `draftInstruction` (`plan.ts:623`) — drafts already have `workdir` and explore on their own, exactly like fast mode's drafts. The brief's real value moves entirely to verify/synthesize (where it already flows via the resumed session or the `briefBlock` fallback fence at `plan.ts:816`). Note: this benchmark shows brief-seeded drafts still anchored on the wrong dialog, so seeding wasn't buying the accuracy it cost in latency; C1/A2 are the actual remedy.
- [ ] **C4. Merge verify + synthesize into one resumed turn** (~1–1.5m + ~200–300k tokens). Replace the two closing stages (`plan.ts:794-879`) with a single `RECON_FINAL_SYS` stage that resumes the recon session: *"First, internally fact-check both drafts against the code you already have in context (adversarial: FABRICATED/WRONG/MISSING/UNNECESSARY discipline from the current VERIFY_SYS), then output ONLY the final plan with every correction applied"* — same shape as `FAST_FINAL_SYS` but with the brief + recon file context already loaded. Keep the fresh-call fallback (re-fence brief + drafts) and the `hasPlanSections` retry/degrade logic. Update the recon `total` from 5 to 4 (`plan.ts:448`), the stage list (`plan.ts:394-401`), and the header comment (`plan.ts:8-11`). Trade-off: we lose the separate "# Corrections report" artifact in the debug view; if that matters, keep `verify` available behind a per-stage override rather than deleting the prompt.
- [ ] **C5 (small). Overlap the clarify screen with recon**: start the recon call immediately and `await` the clarify check concurrently; if clarify returns questions, `ac.abort()` recon and return `clarifyResult` (the abort path already exists). Saves the screen's serial hop on the 95%+ of runs that don't clarify.
- Net recon shape: **clarify ∥ (recon ∥ drafts) → verify-synthesize (resumed)** — wall clock ≈ max(recon, drafts) + one closing stage ≈ 3–3.5m, down from 5m49s, with two fewer serial hops and one fewer full-context stage.

### D. Fast — smallest changes, biggest positioning

- [ ] **D1.** `FAST_FINAL_SYS` and `DRAFT_SYS` pick up `SURFACE_NOTE` via A2 — no other prompt change; its verify-before-adopt + QA contract already match what won for solo Fable.
- [ ] **D2.** Include **fast** in the next benchmark run as the headline contender: at 3 calls with grounded drafts + one grounded verify-finalize, it is the only mode whose wall clock can genuinely undercut solo Fable while adding a cross-check. (It was absent from this run — we have no current data on it.)

## Risks & mitigations

- **Unseeded drafts regress recon draft quality (C3).** Drafts lose the brief but keep full repo access — identical grounding to fast mode's drafts, and this run proves seeding didn't prevent the wrong-surface miss. Mitigation: the brief still gates the closing stage; if bench reps show draft-accuracy regression, revert C3 alone (it's an isolated ordering change) and keep C4's savings.
- **Merged verify-synthesize goes easier on the drafts than a dedicated adversary (C4).** A combined stage might under-fact-check. Mitigation: carry the classification vocabulary and "a draft asserting something is NOT evidence" language verbatim into `RECON_FINAL_SYS`; bench with ≥3 reps against the old 5-call recon before deleting the standalone verify prompt; keep per-stage model overrides working so the old shape stays reachable.
- **Longer blind-stage prompts change relay's character.** B2–B4 add constraints but no new inputs; relay stays 4 calls, drafts-grounded, closing-blind — the benchmarked identity. The fallback guard (B1) only activates on failure paths.
- **Prompt bloat.** Each addition is 1–3 sentences appended to existing constants; no stage gains tools or turns. `--max-turns` budgets in `lib/cli.ts` are untouched.
- **Overfitting to one checklist.** A1/A2 encode a general failure class (named-surface targeting, requirement demotion), not this task's specifics; validation (below) uses more than this one snapshot.

## Testing

1. **Type check**: `npx tsc --noEmit` in the fuse repo (existing `tsconfig.json`).
2. **Unit tests (NEW)** for the relay fallback: feed `hasPlanSections`-failing hardened text + a valid draft through the relay degraded path and assert the draft (not the hardened narration) ships with the WARNING banner. Also assert `hasPlanSections` accepts a plan whose first characters are `## Goal` and rejects the benchmark's actual relay output (fixture: warning + `ls -la` fragment).
3. **Regression fixture**: keep run `6667b959`'s relay output as a stored bad-output example; any future degraded relay/recon result must contain all five sections after the WARNING line.
4. **Re-benchmark (the real gate)**: same snapshot `migma-author-location-fields` plus at least one other task, contenders = solo fable, fast, relay, recon — **≥3 reps, ≥2 judge passes** (this run's 1×1×1 setup cannot distinguish a 2.6-point gap). Success criteria: relay produces a complete plan in every rep (no WARNING outputs); recon covers the named admin surface + all duplicated dialogs and ships byline + JSON-LD by default; recon wall clock ≤3m30s; fast ≥ solo's score at ≤ solo's time.
5. **Smoke test locally**: one recon run against a small repo confirming the new order (drafts start while recon streams — visible in the stage UI), the resumed verify-synthesize lands (`rec.sessionId === pinned` path at `plan.ts:592`), and the plan file writes with the five sections.
