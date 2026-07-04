# Plan: `plan-ux-critic` — a UX-critic pass for Fuse Plan Mode

> **Status:** verified against the real `lib/plan.ts` / `route.ts` / `page.tsx` (Jul 1, 2026). Supersedes the two draft plans (`fuse-plan-ux-critique-skill.md`, `fuse-plan-plan-ux-critic-…md`), both of which contained claims that don't match the current source (see **Corrections** below).

## Goal

After Fuse finishes drafting an implementation plan in **Plan Mode**, add one more pass: a pragmatic **product/UX reviewer** critiques the finished plan against the *original user request* — flagging over-engineering, proposing a leaner approach, and naming concrete UX gaps — and then the aggregator **folds that critique back into the plan**. The saved `fuse-plan-*.md` ends with a short **`## UX notes`** section so the user can *see* what was simplified and why.

Runs **always-on** (no toggle), in **both `attack` and `relay` modes**, in **Plan Mode only** (never in `normal` chat). Projects can customize the critique per-folder by dropping a `**.fuse/skills/plan-ux-critic/SKILL.md**` file into their working directory — this is the per-folder "skill" you asked for.

## Design decisions (and why)

- **A pipeline stage, not a Claude Code `SKILL.md` the CLI chooses to invoke.** Fuse implements every role (drafter, reviewer, hardener, aggregator) as a *system-prompt + stage* in `lib/plan.ts`. A stage runs **deterministically** and is **provider-agnostic** — it works with the `codex-cli` proposer, which has no skills mechanism. The per-folder `SKILL.md` is layered on top of the built-in stage as optional *guidance*, not as the trigger.
- **Two stages: critique → revise (with a gate).** The critic (a proposer) writes a visible critique; the aggregator then revises the plan. This surfaces the critic's actual voice ("cut X", "simplify Y") as its own entry under **Show agent replies**, which is what you described ("it would say maybe we should reduce…"). The revise stage is **gated**: it only runs if the critique produced content — otherwise the plan is kept untouched.
- **Always-on, no toggle.** Per the decision to keep this frictionless. Because it always runs, it needs **no config field, no `route.ts` change, no `app/page.tsx` change, no `types.ts`/`mergeConfig` change** — the two prior drafts' toggle/config plumbing is entirely unnecessary.
- **Runs on the *finished* plan.** Both mode branches already assign `final` before `writePlan`, so **one inserted block covers both modes** (attack: after synthesize; relay: after finalize). Critiquing the strongest artifact gives the highest-signal review.
- **Single saved artifact.** `writePlan(...)` still writes one Markdown file into the working folder. The raw critique is not written to a separate file; it lives in the `proposals[]` debug list, and its *effect* is visible in the plan's `## UX notes`.
- **Fail-safe.** If the critique or the revise stage errors or returns empty, `final` keeps its previous value — the pass can never lose a plan.

## Corrections to the earlier drafts (do not re-introduce these)

The two draft plans were checked against the current code; these claims are **wrong** and are not carried forward:

- ❌ *"Baseline doesn't compile / `node_modules` missing / `lib/chat_moa.ts` missing / `TokenUsage` unimported."* — Fabricated. The tree compiles clean; there is no `chat_moa.ts` (the module is `lib/moa.ts`). **No "Step 0" is needed.**
- ❌ *`runPlan` reads config via `loadConfig()` / add `planUxCritic` to `lib/config.ts`.* — `runPlan` takes config as **positional args**; there is no `lib/config.ts`. Server config lives in `lib/settings-store.ts` + `mergeConfig` in `lib/types.ts`. Always-on needs none of it.
- ❌ *`call(model, [messages], { system })`.* — The real helper is `call(model, system, base, instruction, workdir?, onActivity?)`.
- ❌ *`writePlan` writes to `FUSE_PLAN_DIR || process.cwd()`.* — It writes into **`workdir`** if it exists on disk, else `DATA_DIR/plans` (`lib/plan.ts:145`). This matters for the SKILL.md test: the override file and the output plan live in the same selected folder.

## Affected files

- **`lib/plan-ux-critic.ts`** — **new.** Exports `BUILTIN_UX_CRITIQUE_SYS`, `UX_REVISE_SYS`, and `loadUxCriticSkill(workdir?)`.
- **`lib/plan.ts`** — 4 small edits: add an import, bump the progress `total`, relabel the two branch-final `bump("Done")` calls, and insert the critique→revise block before `writePlan`.
- **`README.md`** *(optional, light)* — one line documenting the per-folder override path.

Explicitly **unchanged**: `app/api/chat/route.ts`, `app/page.tsx`, `lib/types.ts`, `lib/settings-store.ts`, `lib/settings.ts`. (Verified: `runPlan` has exactly one caller, `route.ts:55`, and passes no options object; always-on requires no new argument.)

## Implementation steps

### 1. New file `lib/plan-ux-critic.ts`

`loadUxCriticSkill` returns the **complete** critique system prompt (built-in guidance, plus the project override appended when present), so `lib/plan.ts` uses the return value directly — no re-concatenation of the built-in text.

```ts
// The UX-critic "skill" for Fuse plan mode: a built-in product/UX reviewer
// prompt, the aggregator's revise prompt, and an optional per-project override
// read from <workdir>/.fuse/skills/plan-ux-critic/SKILL.md.
import { promises as fs } from "fs";
import path from "path";

export const BUILTIN_UX_CRITIQUE_SYS = `<<BUILTIN_UX_CRITIQUE_SYS — see Appendix A>>`;
export const UX_REVISE_SYS = `<<UX_REVISE_SYS — see Appendix B>>`;

// Safe override read: fixed relative paths, .md only, size-capped, read-only,
// all errors swallowed → fall back to the built-in guidance.
const MAX_SKILL_BYTES = 20_000;
const LOCAL_SKILL_PATHS = [
  ".fuse/skills/plan-ux-critic/SKILL.md",
  ".codex/skills/plan-ux-critic/SKILL.md", // projects already on Codex conventions
];

export async function loadUxCriticSkill(workdir?: string): Promise<string> {
  if (!workdir) return BUILTIN_UX_CRITIQUE_SYS;          // also catches "" from the web form
  for (const rel of LOCAL_SKILL_PATHS) {
    try {
      const p = path.resolve(workdir, rel);
      const st = await fs.stat(p);
      if (!st.isFile() || st.size > MAX_SKILL_BYTES) continue;
      const text = (await fs.readFile(p, "utf8")).trim();
      if (text) return `${BUILTIN_UX_CRITIQUE_SYS}\n\n## Project-specific UX guidance\n${text}`;
    } catch {
      /* missing/unreadable → ignore, use built-in */
    }
  }
  return BUILTIN_UX_CRITIQUE_SYS;
}
```

Paste the two prompt strings from **Appendix A** and **Appendix B** into the placeholders.

### 2. `lib/plan.ts` — edit 1: import (near the other `./` imports, ~line 14)

```ts
import { UX_REVISE_SYS, loadUxCriticSkill } from "./plan-ux-critic";
```

*(`BUILTIN_UX_CRITIQUE_SYS` is not imported here — `loadUxCriticSkill` already bakes it into its return value.)*

### 3. `lib/plan.ts` — edit 2: raise the progress total (line 177)

```ts
// before:  const total = mode === "attack" ? 5 : 4;
const total = (mode === "attack" ? 5 : 4) + 2; // +2 for the always-on UX critique + revise → 7 attack / 6 relay
```

> **Why this is required (blocker if skipped):** `total` is a `const` set once. The inserted block adds two `bump()` calls, driving `done` to 7/6. Without raising `total`, `onProgress` fires with `done > total` on **every** run and the SSE progress bar (`route.ts:51`) overshoots 100%.

### 4. `lib/plan.ts` — edit 3: relabel the two branch-final bumps

So the label **"Done"** only appears at the true end (after the UX pass), not prematurely at synthesize/finalize:

- Attack branch (~line 263): `bump("Done")` → `bump("Synthesized")`
- Relay branch (~line 290): `bump("Done")` → `bump("Finalized")`

*(Counting is unaffected — still one bump each; only the label text changes.)*

### 5. `lib/plan.ts` — edit 4: insert the critique → revise block

Insert **after** the `if (!final?.trim()) { … }` guard (ends ~line 298) and **before** `const planPath = await writePlan(final, workdir, request);` (~line 300). Both mode branches have already assigned `final`, so this one block serves attack and relay:

```ts
  // --- UX critic pass (always-on; plan mode only) --------------------------
  // A product/UX reviewer critiques the finished plan against the original
  // request; the aggregator then folds that critique back in. Runs with no
  // workdir (reason over the finished plan; don't re-scan the repo). Fallbacks
  // keep `final` intact if either stage errors or returns nothing.
  {
    const critiqueSys = await loadUxCriticSkill(workdir); // built-in (+ optional .fuse/skills override)

    onProgress?.(done, total, "Reviewing UX & scope…");
    const critique = await call(
      b,
      critiqueSys,
      messages,
      `Original request is above. Here is the proposed plan:${fence(final)}\nProduce the UX/scope critique.`,
      undefined,
      makeActivity("Reviewing UX & scope…"),
    );
    bump("UX review ready");
    record(b, "ux critique", critique, "proposer");

    if (critique.content?.trim()) {
      onProgress?.(done, total, "Revising for UX…");
      const revised = await call(
        aggregator,
        UX_REVISE_SYS,
        messages,
        `Current plan:${fence(final)}\nUX/product review to incorporate:${fence(critique.content)}\nProduce the final UX-informed plan.`,
        undefined,
        makeActivity("Revising for UX…"),
      );
      bump("Done");
      record(aggregator, "ux revise", revised, "aggregator");
      if (revised.content?.trim()) final = revised.content; // else keep the pre-critique plan
    } else {
      bump("Done"); // critique empty/errored — keep the plan, keep the counter honest
    }
  }
```

> **Structural note (avoid an off-by-one):** the `else { bump("Done"); }` pairs with the **outer** `if (critique.content?.trim())`, *not* the inner `if (revised.content?.trim())`. Both paths must perform exactly **two** bumps (`"UX review ready"` + `"Done"`) so `done` lands exactly on `total` (7 attack / 6 relay) in every case.

All referenced identifiers — `b`, `call`, `fence`, `record`, `bump`, `makeActivity`, `aggregator`, `done`, `total`, `messages`, `final` — are existing in-scope helpers/vars in `runPlan`. `fs`/`path` are already imported. No new plumbing.

### 6. `README.md` (optional)

One line under a Skills/Plan section: the `plan-ux-critic` reviewer runs by default in both plan modes; a project can tailor it via `.fuse/skills/plan-ux-critic/SKILL.md` (see **Appendix C** for a template).

## Risks & mitigations

- **Extra latency/tokens — 2 CLI calls on every plan.** Accepted (that's the always-on decision). Mitigated by: running with `workdir: undefined` (no repo re-scan), running on a single mature artifact (not per-agent), and the existing idle-timeout runtime (`lib/cli.ts`) keeping long-but-active stages alive. Live progress labels ("Reviewing UX & scope…", "Revising for UX…") show it's working.
- **Progress bar overshoot.** Fixed by edit 2 (`total + 2`); every path does exactly 2 bumps (verified).
- **Critic over-trims / invents scope cuts.** The critique prompt forbids removing correctness/safety steps and forbids dropping explicitly-requested functionality (conflicts surface as noted trade-offs). The revise prompt repeats these as hard constraints and is the arbiter; the fallback keeps the pre-critique plan if revise is empty/errors.
- **Backend/no-UI plans.** Both prompts scale proportionally — critique operator/developer experience (CLI ergonomics, defaults, error messages, logging, docs) instead of inventing a UI.
- **`@@CLARIFY@@` swallowed.** Can't happen: the clarify early-return (`lib/plan.ts:233-239`) precedes the mode branch and thus this block — the sentinel never reaches the critic.
- **Debug mode-detection drift.** `debugDump` (`app/page.tsx:1019`) infers mode from `finalize|harden` (relay) / `synthesize|review of` (attack). The new `ux critique` / `ux revise` labels match neither, and the original labels remain — classification unchanged (the stage count just grows accurately).
- **Malicious/huge/noisy override file.** `loadUxCriticSkill` uses fixed relative paths, `.md` only, `isFile()` + 20 KB cap, and swallows all errors → falls back to the built-in guidance. (A `realpath` containment check is only worth adding if `workdir` is ever exposed to untrusted input; noted, not required for a local-first dev tool.)

## Testing

1. **Static gates:** `npx tsc --noEmit`, `npm run build`, `npm run lint` — all green (one new file, one edited file).
2. **Attack (live):** pick a folder, run **Attack** on a small UI request ("Add a dark-mode toggle"). Expect: progress reaches **7/7** with `Reviewing UX & scope…` → `Revising for UX…`; a `… · ux critique` and `… · ux revise` entry appear under **Show agent replies**; the saved `fuse-plan-*.md` ends with a `## UX notes` section and retains all five plan sections.
3. **Relay (live):** same request in **Relay**. Expect **6/6**, UX pass runs after finalize, `## UX notes` present.
4. **Fail-safe:** temporarily force the revise `call` to throw → the plan is still saved (pre-critique `final`), the run completes, the failed stage shows in the debug list, no crash, no empty output.
5. **Clarify path:** send a deliberately underspecified request → the clarify questions fire *before* any UX stage; nothing is critiqued or saved.
6. **Backend proportionality:** "Add retention cleanup for old conversation records" → the critic invents no UI; it may add operator/failure-mode/observability notes and stays implementation-focused.
7. **Requirement preservation:** a request with an explicit must-have ("must support CSV export") → the improved plan still includes it; any conflicting simplification appears as a noted trade-off in `## UX notes`, not a silent cut.
8. **Per-folder override:** create `<folder>/.fuse/skills/plan-ux-critic/SKILL.md` (e.g. "Prefer keyboard-first flows; avoid modal dialogs.") and run a UI request against that folder → the saved plan reflects the instruction. (Recall the plan file is written into that same folder.)
9. **Provider coverage:** select a `codex-cli` proposer (so the critic runs on `b === codex`) → the pass runs with no skills dependency.

---

## Appendix A — `BUILTIN_UX_CRITIQUE_SYS`

```
You are a UX and product reviewer embedded in Fuse's plan pipeline. You are the last independent voice before an implementation plan ships. You receive (1) the original conversation, including the user's actual request, and (2) a candidate implementation plan written in GitHub-flavored Markdown. Your job is to critique that plan on behalf of the person who will USE what gets built — not to rewrite it, and not to add engineering rigor for its own sake.

Optimize for the end user's real job-to-be-done, not for completeness. A shorter plan that nails the core job beats a thorough plan that buries it under scope no one asked for.

Before writing, silently work out:
- WHO the user is (end user, operator, or developer/API consumer) and the ONE core job they are trying to get done. Infer from the request; do not invent personas the request doesn't support.
- Where the plan does MORE than that job requires — speculative extensibility, premature abstraction, config/toggles/settings nobody asked for, extra surfaces, handling for cases that won't occur, gold-plating.
- Where a simpler, more intuitive approach would reach the same outcome with less code, fewer moving parts, or fewer steps for the user.
- Where the USER's experience has real gaps: unclear or missing states (loading / empty / error / success), no feedback after an action, unhandled error/empty/failure paths, friction or dead-ends in the primary flow, accessibility (keyboard, focus, contrast, labels, screen-reader), and unclear or missing copy (button labels, messages, empty-state text).

Proportionality — match the critique to what is actually being built:
- User-facing UI work: focus on interaction, states, feedback, copy, accessibility, and flow friction.
- Backend, CLI, library, infra, or other no-UI work: do NOT invent a UI. Critique the OPERATOR / DEVELOPER experience proportionally instead — API/CLI ergonomics, naming and defaults, config surface, error messages and exit codes, observability/logging, docs, and failure modes. "UX" here means the experience of whoever consumes this work.

Hard constraints (never violate):
- NEVER recommend removing or weakening a correctness-critical or safety-critical step (data integrity, auth, validation, migrations, error handling, security, concurrency, rollback). Simplify only what is genuinely non-essential to correctness and safety.
- NEVER recommend dropping functionality the user EXPLICITLY requested. If serving the user's real job appears to conflict with something they explicitly asked for, do NOT silently cut it — surface it as an explicit, clearly-labeled trade-off and let the final author decide.
- If a project-specific override is appended below, treat its personas, workflows, principles, constraints, and especially its "never cut" requirements as authoritative and let them override your generic assumptions.

Style:
- Be short and high-signal. Prefer a few high-impact points over an exhaustive list. Skip anything the plan already handles well — no praise, no filler, no restating the plan.
- Be concrete: name the specific step, section, file path, state, or copy string you mean. If a heading has nothing worth saying, write "None" under it rather than padding.
- If the plan is already lean and user-appropriate, say so briefly instead of manufacturing problems.

Output ONLY Markdown with EXACTLY these four headings, in this order, and nothing before or after:

## What the user actually needs
One or two sentences: who the user is and the core job-to-be-done this plan should serve.

## Cut / simplify
Bulleted. Scope to cut or defer and over-engineering to drop, each with a one-line why. Flag any conflict with an explicitly requested feature as a trade-off rather than a cut. "None" if nothing.

## UX gaps
Bulleted. Concrete gaps in the user's (or operator's/developer's) experience — missing states, feedback, error/empty/loading handling, primary-flow friction, accessibility, copy. "None" if nothing.

## Recommended leaner approach
A few sentences (or a short list) describing the simplest version that still does the job and preserves every correctness/safety step and every explicitly requested feature. If the plan is already right-sized, say so.
```

## Appendix B — `UX_REVISE_SYS`

```
You are the lead engineer producing the FINAL, implementation-ready plan for Fuse. You are given (1) the original conversation with the user's request, (2) the current candidate plan in GitHub-flavored Markdown, and (3) a UX/product review of that plan. Your job is to fold the review's judgment into the plan and output the definitive version — leaner where the review justifies it, and stronger where it flags a real gap.

How to apply the review:
- Trim or defer scope the review flagged as over-engineering or as not serving the user's core job. When you defer rather than delete, note it in the closing UX notes.
- Adopt the review's simpler/more intuitive approach where it is justified and does not sacrifice correctness or safety. Fold it into ## Implementation steps and update ## Affected files to match (remove files no longer touched, add any newly needed).
- Add concrete steps that close each UX gap the review raised — states (loading / empty / error / success), post-action feedback, error/empty/failure handling, primary-flow friction, accessibility, and copy. For backend/CLI/library/no-UI work, close operator/developer-experience gaps instead (naming, defaults, config, error messages, exit codes, logging, docs) — do not invent a UI.
- Use your own judgment: the review is advisory. Where it is wrong, over-reaches, or conflicts with the request, keep the plan correct and briefly note why in the UX notes.

Hard constraints (never violate):
- NEVER drop or weaken a correctness-critical or safety-critical step (data integrity, auth, validation, migrations, error handling, security, concurrency, rollback), even if the review suggested it. Keep every such step.
- NEVER drop functionality the user EXPLICITLY requested. If the review's simplification conflicts with an explicit request, honor the request and record the tension in the UX notes as a trade-off.
- Keep the plan concrete and implementation-ready: reference REAL file paths and specific functions/symbols. Do not introduce vague TODOs where the current plan is specific.

Structure:
- Preserve EXACTLY these five sections, with these headings, in this order: ## Goal, ## Affected files, ## Implementation steps, ## Risks & mitigations, ## Testing. Do not rename, reorder, drop, or merge them.
- After ## Testing, append ONE final section: ## UX notes — a brief (a few bullets) summary of the key UX/product decisions you made, what you cut or deferred and why, and any explicit-request trade-offs you preserved. Keep it tight; it is a rationale summary, not a changelog.

Output ONLY the final Markdown plan (the five required sections followed by ## UX notes). No preamble, no commentary, no code fences around the whole document.
```

## Appendix C — `.fuse/skills/plan-ux-critic/SKILL.md` template

Drop this into a project's working folder to tailor the critique for that project. All sections are optional; delete what you don't need.

```markdown
# plan-ux-critic — project override

<!--
  Project-local UX-critic guidance for Fuse plan mode.
  Location: <workdir>/.fuse/skills/plan-ux-critic/SKILL.md
  This file is READ-ONLY input. Its trimmed contents are appended to Fuse's
  built-in UX-critique guidance during the "ux critique" stage of plan mode
  (both attack and relay). It does NOT run in normal chat.
  Everything you write here OVERRIDES the reviewer's generic assumptions for
  THIS project. Delete sections you don't need — empty sections are fine.
  Keep it short and specific; it is prepended context, not documentation.
-->

## Target users / personas
<!--
  Who actually uses what this project builds? List 1-3 concrete personas and,
  for each, the core job-to-be-done. This is the single biggest lever on
  critique quality — the reviewer optimizes for these people.
-->

## Primary workflows
<!--
  The main flow(s) the plan should keep smooth. What does the user do first,
  next, last? Where must friction be lowest?
-->

## Product / UX principles
<!--
  The taste and priorities the reviewer should apply for THIS project.
  e.g. bias to the leanest plan; prefer zero-config over toggles; plain copy.
-->

## Design-system / platform constraints
<!--
  Platform, framework, or design-system rules a plan must respect. Prevents the
  reviewer from suggesting off-platform or off-system changes.
-->

## Hard requirements — NEVER cut
<!--
  Non-negotiables the critique must never recommend removing, weakening, or
  deferring — even to simplify. Treated as authoritative.
-->
```
