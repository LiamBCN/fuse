# Plan: "Plan Critic" skill — a UX & scope review stage for Fuse Plan Mode

**Status:** Plan only (no code written yet)
**Scope:** Add a product/UX critic stage to Fuse's Plan Mode pipeline (`attack` + `relay`). Always on. Plan mode only — normal MoA chat is never affected.
**Owner decisions locked in:** No toggle. Always on. Plan mode only. Critique runs on the **aggregator** model.

---

## 1. What we're building & why

When Fuse produces an implementation plan (attack or relay mode), a new stage reviews the drafted plan through a **product & UX lens** before it is finalized. It asks:

- Is this what the user actually needs, or a literal-but-unhelpful reading of the request?
- Will the resulting experience be simple for how the user will *actually use* it?
- Is the scope too large / over-engineered? What can be **cut or deferred** without hurting the core outcome?
- Is there a materially **simpler approach** that delivers the same user value?
- Is the plan coherent and grounded (no contradictions or hand-waves)?

The finalizer then **folds the critique in** and ends the plan with a short `## UX & scope decisions` section. This turns Fuse plans from "technically complete" into "technically complete **and** user-sensible," and biases them toward subtraction instead of gold-plating.

This also complements the reliability work already diagnosed: the tool-less finalize stage can produce degenerate output (roleplayed tool calls, meta-narration, near-empty plans). The critic is built tool-less with an explicit "no tool narration" guard so it never reintroduces that failure, and its output should later be routed through the planned quality-gate.

---

## 2. Design decisions (and why)

- **Native pipeline stage, NOT a Claude Code `SKILL.md`.** A `.claude/skills/*.md` file would only fire when a workdir is set *and* the active CLI is Claude (not Codex), can't be forced to run at a specific point, pollutes the user's repo, and wouldn't surface as a Fuse stage or in usage/debug. A native stage is deterministic, works for both CLIs, shows up automatically as `provider/model · ux critique`, and degrades gracefully. The critic persona + rubric live in their own module (`lib/ux-critic.ts`) so it still reads like a self-contained, iterable "skill."
- **Always on, plan mode only.** The stage is added inside `runPlan` (which only runs for `attack`/`relay`). Normal mode goes through `runMoa`, which we do not touch — so "plan mode only" needs no gating code and no config flag.
- **No config / no toggle.** Nothing added to `FuseConfig`, `DEFAULT_CONFIG`, `mergeConfig`, `ChatBody`, the send body, or the Settings page. Zero config surface.
- **Tool-less critic.** The critic call is made with **no workdir**, so per `lib/cli.ts:211-224` it runs `--tools ""` — pure reasoning over the plan text + the original request. The drafts already did repo grounding; giving the critic the repo would reintroduce the turn-exhaustion / roleplayed-tool-call bug we diagnosed.
- **Runs on the aggregator model** (the "lead" voice), as a distinct persona, feeding the finalizer. Alternative for more independence: run it on proposer `a` instead — noted in Risks, not chosen.
- **Placement:** after technical review/harden, **before** the finalizer, so the finalizer reconciles it:
  - Attack: `draft∥ → cross-review∥ → UX critique → synthesize`
  - Relay: `draft∥ → harden → UX critique → finalize`

---

## 3. Files touched / not touched

**Touched**
- `lib/ux-critic.ts` — **new**. The critic "skill": system prompt (rubric), output contract, instruction builders.
- `lib/plan.ts` — add the critic stage to both pipelines; bump the stage count; extend the two finalizer prompts + instructions.

**Explicitly NOT touched (confirmed unnecessary):**
- `lib/types.ts`, `lib/settings.ts`, `lib/settings-store.ts`, `app/api/settings/route.ts`, `app/settings/page.tsx` — no config, no toggle.
- `app/api/chat/route.ts` `ChatBody` + `app/page.tsx` `send()` body — no new flag to transmit.
- `lib/moa.ts` — normal mode untouched.
- Progress/debug UI (`app/page.tsx`, `app/history/[id]/page.tsx`) — renders the new stage automatically (see Phase 0).
- `app/pipeline/page.tsx` — decoupled marketing explainer (already out of sync; do not rely on it).

---

## 4. Phase 0 — Grounding (Allowed APIs & anti-patterns)

Verified integration points in `lib/plan.ts` (read directly):

- Stage-prompt constants: `DRAFT_SYS`/`REVIEW_SYS`/`SYNTH_SYS`/`HARDEN_SYS`/`FINAL_SYS`/`FILE_NOTE` — lines **73–102**.
- `call(model, system, base, instruction, workdir?, onActivity?)` — lines **109–124**. **Omit workdir ⇒ tool-less** (`lib/cli.ts:211-224`).
- `record(model, stage, r, role)` — lines **196–201**. Pushes a proposal labeled `` `${model.model} · ${stage}` `` + appends usage.
- `bump(label, ag?)` — lines **179–182**. Increments `done`, calls `onProgress`.
- **Hardcoded stage count:** `const total = mode === "attack" ? 5 : 4;` — line **177**. Must become `6 : 5`.
- Attack stage records: `review of B` / `review of A` at **250–251**; synthesize call at **254–264**; `final = syn.content || ra.content || ...` at **265**.
- Relay stage records: `harden A` at **279**; finalize call at **281–291**; `final = finalized.content || hardened.content || ...` at **292**.
- `runPlan(messages, proposers, aggregator, mode, workdir?, onProgress)` — signature **159–166**. **No signature change needed** (critic is unconditional).

Rendering (all generic — no UI change needed beyond the stage itself):
- Live run UI `app/page.tsx:645–692` (label 651, `step X/Y` denominator 654, bar fraction 686, agent chips 657–681).
- Proposal label renders at `app/page.tsx:1245` and `app/history/[id]/page.tsx:117–119` → a new `record(..., "ux critique", ...)` shows as `provider/model · ux critique` automatically. All counts ("Show N agent replies", "N agents answered", "N stages") are dynamic.

**Anti-patterns to avoid (verified traps):**
1. **Every `total` increment needs a matching `bump()`** or the progress bar never reaches 100%.
2. **Do not give the critic a workdir** — it re-triggers the `--tools ""`-vs-agentic roleplay bug. Keep it tool-less.
3. **Do not block the plan on the critic** — if the critic errors, the finalizer must proceed exactly as today.
4. **Do not touch `app/pipeline/page.tsx`** expecting function — it's a decoupled explainer (depicts a non-existent "risk gate").
5. The `debugDump` mode-inference regex (`app/page.tsx:1019–1023`, `/finalize|harden/` / `/synthesize|review of/`) stays correct because we **add** stages and keep the existing anchor names.

---

## 5. Phase 1 — Author the UX-Critic skill module (`lib/ux-critic.ts`, new file)

**What to implement:** a self-contained module encapsulating the critic. No pipeline wiring yet.

Export:
1. **`UX_CRITIC_SYS`** — the critic system prompt encoding this rubric:
   - **Real user need** — does the plan serve the user's actual job-to-be-done?
   - **Scope discipline (bias to subtraction)** — what can be **cut/deferred** without hurting the core outcome? Flag over-engineering, premature abstraction, gold-plating.
   - **UX quality** — will the result be simple/intuitive for how the user actually uses it (fewer steps, sane defaults, progressive disclosure)?
   - **Simplest viable approach** — if a materially simpler implementation delivers the same value, recommend it concretely.
   - **Coherence/grounding** — contradictions, hand-waves, unsupported claims.
   - **Guardrails:** prefer removing over adding; never introduce new features/scope; if the plan is already lean and user-centered, say so briefly and pass it through (do **not** manufacture critique); **you have no file access — do not read, run, or verify files, and do not narrate or simulate tool use (`Bash(...)`, `Running…`, tool-result glyphs).**
2. **`UX_CRITIC_OUTPUT`** — the output contract: a **concise, prioritized critique, not a plan rewrite.** Sections: `### Keep`, `### Simplify / cut`, `### Reconsider approach`, `### How the user will actually use this` (2–4 sentences).
3. **Builders:** `critiqueInstruction(planText: string)` → the user instruction handed to the critic; `foldInInstruction(critiqueText: string)` → the text appended to the finalizer's instruction (returns `""` when critique is empty).

**Verification:** imports resolve; `tsc`/`next build` clean; no runtime wiring yet.
**Anti-pattern guard:** the prompt must explicitly forbid tool-use narration and full-plan rewrites (prevents degenerate output; keeps the stage cheap).

---

## 6. Phase 2 — Integrate the critic stage into `runPlan` (both modes)

**What to implement in `lib/plan.ts`:**

1. **Import** `UX_CRITIC_SYS`, `critiqueInstruction`, `foldInInstruction` from `./ux-critic`.
2. **Bump the stage count** (line 177): `const total = mode === "attack" ? 6 : 5;`.
3. **Attack path** — after the two cross-review `record(...)` calls (250–251) and **before** the synthesize call (254):
   - `onProgress?.(done, total, "Critiquing for UX & scope…")`
   - `const crit = await call(aggregator, UX_CRITIC_SYS, messages, critiqueInstruction(<the same "Plan 1 / Plan 2" text synthesize receives>), undefined, makeActivity("Critiquing for UX & scope…"))` — **`undefined` workdir = tool-less.**
   - `bump("UX critique ready")`
   - `record(aggregator, "ux critique", crit, "aggregator")`
   - Pass `crit.content` into the synthesize instruction (Phase 3).
4. **Relay path** — after `record(b, "harden A", ...)` (279) and **before** the finalize call (281): same pattern, critiquing the hardened plan (`hardened.content || da.content`); `record(aggregator, "ux critique", crit, "aggregator")`.
5. **Graceful degradation:** `call()` already converts errors to `{content:"", error}`. If `crit.content` is empty, `foldInInstruction("")` returns `""` and the finalizer behaves exactly as today. The critic never blocks the plan.

**Verification:** attack shows `step X/6`, relay `step X/5`; a `provider/model · ux critique` entry appears under "Show N agent replies" and in the history debug view.
**Anti-pattern guards:** matching `bump()` for the `total` increment (trap #1); no workdir on the critic call (trap #2); empty-critique path proceeds unchanged (trap #3).

---

## 7. Phase 3 — Finalizer folds in the critique + emits "UX & scope decisions"

**What to implement in `lib/plan.ts`:**

- Extend **`SYNTH_SYS`** (91–93) and **`FINAL_SYS`** (99–102) so that, when a critique is present, the finalizer is told: *"A product/UX critic reviewed this plan. Fold in its recommendations where they improve the user outcome or cut unnecessary scope; briefly note any you deliberately reject and why. End the plan with a short `## UX & scope decisions` section summarizing what was simplified/cut and how the user will actually use the result."*
- Append `foldInInstruction(crit.content)` to the existing synthesize instruction (259) and finalize instruction (286). When `crit.content` is empty, `foldInInstruction` appends nothing → identical to today's output.

**Verification:** a completed plan ends with a populated `## UX & scope decisions` section referencing concrete cuts/simplifications. If the critic errored, the section is absent and output matches pre-change behavior.
**Anti-pattern guard:** the finalizer **reconciles** the critique (it may reject over-aggressive cuts) — the critique is advisory, not authoritative, so a bad critique can't gut a good plan.

---

## 8. Phase 4 — Verification (full)

No test framework exists in this repo (validation here is typecheck + manual run + deploy).

1. **Typecheck/build:** `npx tsc --noEmit` (or `npm run build`) clean.
2. **Behavior (run a real plan request with a folder selected):**
   - Attack → `step X/6`, a `· ux critique` proposal present, final plan has `## UX & scope decisions`.
   - Relay → `step X/5`, same checks.
   - Normal mode → unchanged (no critique stage; `runMoa` untouched).
3. **Graceful degradation:** force the critic call to fail (e.g. point the aggregator at a bogus model) → plan still completes via the existing fallback; the failed stage shows as a red error proposal, not a blocked run.
4. **No roleplay regression:** confirm the critique text contains no tool-result glyph (`⎿`), no "Running…", no fabricated `Bash(...)`/`Read(...)` lines — the tool-less guard working.
5. Deploy via `scripts/deploy.sh` and smoke-test one plan end-to-end in the packaged app.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Extra latency/cost (+1 aggregator call per plan) | Accepted (always-on by decision); critique is short and tool-less; output contract forbids full-plan rewrites |
| Critic itself produces degenerate / tool-roleplay output | Tool-less + explicit no-tool-narration guard; route through the planned reliability quality-gate and discard if degenerate |
| Critic over-trims and guts a good plan | Finalizer reconciles (may reject cuts); rubric biases to "pass through if already lean" |
| Progress bar stuck < 100% | Every `total` bump paired with a `bump()` (Phase 0 trap #1) |
| Critic failure blocks the plan | `call()` swallows errors → empty critique → finalizer proceeds unchanged (Phase 0 trap #3) |
| Weak independence (same model critiques then finalizes) | Acceptable (distinct personas). Variant if desired: run the critique on proposer `a` instead of the aggregator |

---

## 10. Out of scope / follow-ups

- **Reliability quality-gate** (degenerate-output detection + best-valid-candidate fallback + one retry) — planned separately; the critic's output should be routed through it once it lands.
- **Normal MoA mode** critique — intentionally excluded per decision.
- **`app/pipeline/page.tsx`** explainer — optionally update its cards later to depict the critique step (cosmetic only).
