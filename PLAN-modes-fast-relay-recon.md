# Plan: Three Modes — Fast, Relay, Recon (remove Normal, restore Relay)

## Goal

Reshape the mode lineup to exactly three choices — **Fast**, **Relay**, **Recon** — by:
1. **Removing "Normal"** as a selectable mode. The mode menu only ever mattered for planning; folderless chat keeps working exactly as today (a fused answer, no plan file) no matter which mode is selected.
2. **Restoring "Relay"** — the original 4-stage hand-off pipeline (drafts ∥ → Codex hardens → Opus finalizes) that won the first 3-mode benchmark at 8.93. It was retired because Fast was built as its streamlined successor (and out-scored it 9.025 on the re-benchmark), but it comes back as its own mode; the bench harness can settle Fast vs Relay head-to-head any time.
3. **Renaming "Deep" → "Recon"** — same pipeline, the name users already know. All of Deep's improvements are kept (shared resumed session for recon/verify/synthesize, clarify pre-check, verify seeded with the brief, retry + WARNING fallback).

Result: `Mode = "fast" | "relay" | "recon"`.

## Key behavior decision (the Normal removal)

Today "Normal" = the fused chat answer (`runMoa`), and it's already hidden whenever a folder is active. Removing it raises one question: what happens in Chat (no folder)?

**Decision: when no folder is active, every mode produces the normal fused chat answer — planning pipelines run only with a folder.** The mode choice becomes "which plan pipeline runs when I'm in Folder mode," which is what the menu was really for. Two consequences, both improvements:
- Casual chat behaves exactly as today; nothing to relearn, no plan files from questions.
- A long-standing wart disappears: currently a plan mode selected while in Chat still runs the whole plan pipeline **ungrounded** (no folder access) and writes a plan file into the app data dir — the blind-planning failure mode the grounded redesign exists to prevent.

Mechanically: the `/api/chat` route branches on **workdir presence** instead of `mode !== "normal"` (the client already sends `workdir` only when Folder mode is on).

## The three pipelines after this change

| Mode | Pipeline | Calls | Grounding |
|---|---|---|---|
| **Fast** | drafts ∥ → verify-and-finalize (one grounded Opus pass) | 3 | every stage |
| **Relay** | drafts ∥ → Codex hardens A (blind) → Opus finalizes (blind) | 4 | drafts only (restored exactly as benchmarked) |
| **Recon** | clarify screen → recon → drafts ∥ → verify → synthesize (recon/verify/synthesize share one resumed claude session) | 5 (+screen) | every stage |

## Affected files

- `lib/types.ts` — edit: `Mode` union, mode doc comment, `DEFAULT_CONFIG.mode`, `mergeConfig` migrations.
- `lib/plan.ts` — edit: restore the relay branch (prompts + else-branch below), rename deep→recon in the mode checks and comments, per-mode `total` math (relay = 4).
- `app/api/chat/route.ts` — edit: branch on `workdir` instead of `mode !== "normal"`.
- `app/page.tsx` — edit: `MODE_OPTIONS` (three entries, no Normal), remove the folder filter for Normal, remove the hover-image preview block (no option has an image anymore), tooltip copy, `selectFolder` no longer needs a mode upgrade, `debugDump` label `"deep"` → `"recon"`.
- `app/pipeline/page.tsx` — edit: three `PLAN_VARIANTS` (Fast / Relay / Recon), restore `RelayFlow`, rename `DeepFlow` → `ReconFlow`, reframe the top "How it works" (MoA) section as what Chat-without-a-folder does.
- `public/plan-normal.png` — delete (orphaned once the hover preview goes).
- `lib/moa.ts`, `lib/cli.ts`, `lib/providers.ts` — no changes (runMoa still powers folderless chat; session plumbing untouched).

## Implementation steps

1. **`lib/types.ts`** — set `Mode = "fast" | "relay" | "recon"`; `PlanMode = Mode` (drop the `Exclude`, every mode is a plan mode now — keep the alias so imports don't churn). `DEFAULT_CONFIG.mode: "fast"`. Update `mergeConfig`:
   - accept `fast | relay | recon` as-is;
   - migrate stored legacy values: `normal → fast`, `deep → recon`, `relay2 → relay`, `attack → recon`;
   - delete the `folderMode && mode === "normal"` upgrade line (no normal to upgrade).
2. **`lib/plan.ts`** — restore the relay pipeline exactly as it ran in the winning benchmark, as a `mode === "relay"` branch between fast and recon:
   - Re-add the two prompts (verbatim from the benchmarked version, with `QA_NOTE` appended to FINAL_SYS as the one modernization):
     ```ts
     const HARDEN_SYS =
       "You are hardening another engineer's implementation plan. Identify risks, edge cases, and missing steps; fold in anything " +
       "stronger from the alternative plan; output a hardened Markdown plan. Output only the plan.";

     const FINAL_SYS =
       "You are the lead engineer producing the FINAL, implementation-ready plan. Compare the hardened plan with the original " +
       "approach, think carefully about remaining risks and edge cases, and resolve every blocking risk so it is safe to implement " +
       "with minimal surprises. Keep it concrete with real file paths. Output only the final Markdown plan." + QA_NOTE;
     ```
   - Branch body (as benchmarked: harden and finalize run **blind**, `workdir` deliberately omitted):
     drafts (shared stage, already grounded + heartbeats) → `call(b, HARDEN_SYS, messages, "Primary plan to harden: <A> / Alternative plan for reference: <B> / Produce the hardened plan.", undefined, makeActivity("Hardening the plan…"))`, `record(b, "harden A", …)` → `call(aggregator, FINAL_SYS, messages, "Hardened plan: <hardened||A> / Original approach: <A> / Produce the final implementation-ready plan.", undefined, makeActivity("Finalizing the plan…"))`, `record(aggregator, "finalize", …)`.
   - Give relay's finalize the same retry-once + `degraded` WARNING treatment fast/recon already have (retry the finalize call once if it errors/empties; fall back to `hardened || draft A || draft B` with the WARNING header).
   - `total`: `mode === "relay" ? 4 : mode === "fast" ? 3 : 5`.
   - Rename the remaining `mode === "deep"` checks to `"recon"` (clarify pre-check, recon stage, the deep else-branch) and update the header comment to list all three pipelines. Stage labels ("recon", "verify", "synthesize") stay as-is.
3. **`app/api/chat/route.ts`** — replace `if (mode && mode !== "normal")` with `if (workdir)`: workdir present → `runPlan(messages, proposers, aggregator, mode ?? "fast", workdir, onProgress)`; no workdir → `runMoa(...)` as today. (The `mode` field stays in the body for runPlan; `rounds` keeps feeding runMoa.)
4. **`app/page.tsx`**:
   - `MODE_OPTIONS` → three entries: Fast ("Speed: two agents draft plans from your real code in parallel, then the strongest model fact-checks the load-bearing claims against the source and finalizes. In Chat without a folder, every mode just answers normally."), Relay ("The classic hand-off: two agents draft from your real code, one hardens the other's plan, then the strongest model finalizes. Lighter checking than Fast/Recon - fastest deep-reasoning pipeline."), Recon ("Power: one model recons your code into a ground-truth brief, two agents draft from it, then verify and synthesis run inside the recon session - every claim checked with the files already in context. Slowest, maximum-confidence plan.").
   - Remove the `filter((o) => !cfg.folderMode || o.value !== "normal")` — all three always shown.
   - Remove the hover floating-preview block and the `img` field (no option carries an image now); delete `public/plan-normal.png`.
   - Tooltip: "How the agents work - Fast/Relay/Recon planning pipelines (plans saved as .md; in Chat they answer normally)."
   - `selectFolder`: drop the `cfg.mode === "normal" ? … : cfg.mode` upgrade — keep the stored mode untouched.
   - `debugDump`: change the inferred label `"deep"` to `"recon"`; keep the legacy `relay v2`/`attack` branches.
5. **`app/pipeline/page.tsx`** — `PlanVariant = "fast" | "relay" | "recon"`; three tabs (default `recon`, keep its recommended tag). Restore `RelayFlow` (from the pre-consolidation version): drafts Pair → Harden StepCard ("Codex folds in the best of Plan B - no re-reading") → Finalize Hero → plan.md node; re-add the small `ReviewIcon` it used. Rename `DeepFlow` → `ReconFlow`. Update each variant's `why` copy to match the blurbs above, and note in Relay's copy that harden/finalize reason over the drafts without re-opening files (its honest trade-off). Reframe the top MoA section's intro line as "Chat - no folder: every agent answers and the strongest model fuses them."
6. **Typecheck + build**: `npx tsc --noEmit && npx next build`.
7. **Benchmark all three** on the standing harness before deploying:
   ```
   npx next dev -p 3031
   ./scripts/bench-plan-modes.sh fast  --url http://127.0.0.1:3031
   ./scripts/bench-plan-modes.sh relay --url http://127.0.0.1:3031
   ./scripts/bench-plan-modes.sh recon --url http://127.0.0.1:3031
   ```
   Acceptance: relay completes 4 clean stages in ~15 min with a plan comparable to its 8.93 baseline; fast/recon unchanged from their 9.0+ results; zero fabrications everywhere (blind-judge if in doubt).

## Risks & mitigations

- **Behavior change: plan mode in Chat no longer produces a plan file.** Anyone who used "Relay in Chat mode" to get an ungrounded plan.md now gets a chat answer; they must switch on Folder mode to plan. This is intended (ungrounded planning is the fabrication path), and the Fast blurb says so - but it belongs in the release note.
- **Relay's blind stages stay blind by design.** That's the restored mode's identity (and its speed); the WARNING-header fallback and QA_NOTE are the only modernizations. Don't wire the session chain into it - if we ever want "relay, grounded" back, that was relay2, which lost twice.
- **`PlanMode` type churn.** `PlanMode` widens to all three values; `runPlan` signatures don't change. Grep for any `mode !== "normal"` or `"normal"` comparisons outside the edited files (settings pages, chat-runtime) and clean them - `lib/chat-runtime.ts` carries no mode logic, but verify with `grep -rn '"normal"' app lib`.
- **Stored configs.** Users on the uncommitted Fast/Deep build have `mode: "deep"` saved; users on the released build have `normal/recon/relay/relay2/attack`. The migration matrix in step 1 covers both generations; `mergeConfig` runs on every load, so no data migration is needed.

## Testing

- `npx tsc --noEmit` and `npx next build` green.
- Manual: in Chat (no folder) ask a question under each of the three modes → normal fused answer, no plan file, no plan progress UI. Switch to Folder mode → each mode runs its pipeline with the right stage count (3/4/5) and writes plan.md.
- Config migration: seed a settings file with each legacy mode value (`normal`, `deep`, `relay2`, `attack`) and confirm `mergeConfig` lands on `fast`/`recon`/`relay`/`recon` respectively.
- The step-7 benchmark run, judged against `scripts/bench/prompt-migma.txt` if scores are needed.
