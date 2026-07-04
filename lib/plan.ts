// Plan Mode pipelines. Two models (the configured proposers) draft an
// implementation plan in parallel; later stages verify, harden, and/or finalize
// depending on the selected mode, and the result is written to a Markdown file
// in the working folder.
//
// fast: draft ∥ → verify-and-finalize (one grounded pass)          - 3 calls
// relay: draft ∥ → blind harden-and-finalize                       - 3 calls
// recon: clarify ∥ recon ∥ draft ∥ → verify-and-finalize           - 4 counted
//        calls, where the finalizer resumes the recon session when available
//        so the files recon read stay in context.
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { existsSync, readdirSync } from "fs";
import path from "path";
import { callModel, type ActivityInfo, type ChatMessage, type CliSandbox, type CliSession } from "./providers";
import { estimateCost } from "./models";
import { DATA_DIR } from "./db";
import { AgentFailedError, RunStoppedError, classifyCliError } from "./run-control";
import type { AgentStatus, ProgressFn } from "./moa";
import type { ModelRef, PlanMode, Proposal, StageInfo, StageKey, StageModelMap } from "./types";
import type { Effort } from "./types";
import type { UsageItem } from "./db";

export interface PlanResult {
  final: string;
  proposals: Proposal[];
  usageItems: UsageItem[];
  planPath: string;
  files?: string[]; // absolute paths of all plan files produced (for handoff)
  needsClarification?: boolean;
  questions?: string[];
}

// Bounded recursive file listing (skips heavy dirs) so we can diff which files
// the agents created during the run. Returns null if the tree is too large.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".next", "build", "out", ".cache", "coverage",
  "vendor", ".turbo", ".venv", "venv", "__pycache__", ".idea", ".vscode",
]);
function listFiles(root: string, cap = 20000): Set<string> | null {
  const out = new Set<string>();
  const stack = [root];
  while (stack.length) {
    let entries;
    const dir = stack.pop()!;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else {
        out.add(full);
        if (out.size > cap) return null; // too big - skip diffing
      }
    }
  }
  return out;
}

// Agents emit `@@CLARIFY@@ ["q1","q2"]` only when genuinely blocked. Pull those out.
function extractQuestions(text: string): string[] {
  const i = text.indexOf("@@CLARIFY@@");
  if (i < 0) return [];
  const after = text.slice(i + "@@CLARIFY@@".length);
  const m = after.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (Array.isArray(arr)) return arr.filter((x) => typeof x === "string" && x.trim()).map((s) => String(s).trim());
  } catch {}
  return [];
}

// Appended to every stage's system prompt: agents may create plan artifacts but
// must not implement the feature or change existing source.
const FILE_NOTE =
  " When a working directory and tools are available, you MAY create Markdown/notes/scratch files in the working directory to help craft the plan (e.g. plan docs, " +
  "checklists, diagrams). Do NOT modify existing source files, refactor, or implement the feature - your deliverable " +
  "is the plan, not code changes.";

// Every stage that writes or checks a Testing section gets this rule. The
// 3-mode benchmark's one universal failure was QA text asserting behavior the
// current code cannot satisfy (all three plans "tested" a draft-articles flow
// the target app doesn't have) - grounded plans, ungrounded expectations.
export const QA_NOTE =
  " TESTING MUST BE GROUNDED: never write a Testing/QA step that asserts behavior the current code cannot satisfy. Every test step either cites where the behavior lives today (path:line) or names the implementation step that creates it; when a test depends on existing behavior you did not verify, phrase it as 'first verify that X currently does Y (check <path>)'.";

export const SURFACE_NOTE =
  " SURFACE TARGETING: when the request names a UI location, first locate that exact surface and cite it. Then enumerate EVERY duplicated implementation of the same UI (repos often carry 2-3 copies of the same dialog/form) and cover each or explicitly scope it out - never silently patch only one copy.";

export const REQUIREMENT_COVERAGE_NOTE =
  " REQUIREMENT COVERAGE: enumerate every numbered/bulleted requirement in the request and cover each in the plan; if you intentionally exclude one (out of scope, impossible today, needs a product decision), say so explicitly under Risks & mitigations with the reason - never drop a requirement silently. A location the request names (a specific page, screen, dialog, or flow) is itself a requirement - change that exact surface, not a similar one elsewhere. Demoting a requested behavior to 'optional', 'polish', or 'skip unless requested' counts as dropping it: ship it by default or justify the exclusion under Risks & mitigations.";

const DRAFT_SYS =
  "You are a senior software engineer creating an IMPLEMENTATION PLAN (do not write the full code). " +
  "Strongly prefer to make reasonable assumptions (state them clearly) and write the plan. ONLY if you genuinely cannot " +
  "produce a useful plan without specific information from the USER that you cannot assume or find in the project, respond " +
  'with NOTHING except a line: @@CLARIFY@@ followed by a JSON array of short question strings, e.g. @@CLARIFY@@ ["Which database is used?", "Should it support multiple users?"]. ' +
  "If a project is available in the working directory, inspect the relevant files first and reference real paths. " +
  "Produce a thorough, concrete, step-by-step plan in GitHub-flavored Markdown with sections: " +
  "## Goal, ## Affected files, ## Implementation steps, ## Risks & mitigations, ## Testing. Your VERY FIRST characters must be ## Goal. Output only the Markdown plan." +
  SURFACE_NOTE;

// Cheap tool-less screen that runs alongside recon mode's expensive first wave.
// If it finds real blocking questions, the in-flight recon/drafts are aborted.
// Fast mode has no pre-draft stage, so its drafts screen as they always did.
const CLARIFY_CHECK_SYS =
  "You screen a feature request before an expensive multi-stage planning pipeline runs against a real codebase. The planners can read the entire project, so NEVER ask about anything discoverable from code (frameworks, file locations, existing behavior, conventions). Only if the request is genuinely undecidable without the user - a missing target, contradictory requirements, or a product decision with multiple valid interpretations that materially change the plan - reply with a line: @@CLARIFY@@ followed by a JSON array of short question strings. Otherwise reply with exactly: NO. Reply with nothing else.";

// fast mode's single post-draft stage: verify the drafts' load-bearing claims
// against the source and finalize, in one grounded pass.
const FAST_FINAL_SYS = `You are the lead engineer producing the ONE final, implementation-ready plan, with live read access to the real code in the working directory. Two engineers each drafted a plan for the same request; both read the real code, but neither draft was fact-checked. In ONE pass you must verify what matters and finalize: your output is the plan a developer will actually execute, so it must be correct, right-scoped, and complete - not just a blend.

VERIFY BEFORE YOU ADOPT (non-negotiable): a draft asserting something is NOT evidence - the file is. Before a file path, symbol, signature, endpoint, or "X already exists" claim from either draft goes into your plan, confirm it with a targeted Read/Grep. Prioritize the load-bearing claims: files to edit, signatures to call, integration points, and any step justified by "the code already handles X". Where the drafts disagree, open the file and keep the version the code supports. Drop anything you cannot confirm unless it is explicitly labeled as NEW work with its real integration point, and delete steps that duplicate what the code already handles or scope the request never asked for.
- Treat every end-to-end Testing step as a claim set: before asserting a user-visible flow works today, confirm each leg of it in the code, and if any leg does not exist, convert the step into "first verify..." or tie it to the implementation step that creates it.

SCOPE DISCIPLINE: you have Read/Glob/Grep and a STRICT budget of about 40 tool calls. The drafts already did the exploration - do NOT re-crawl the repo. Spend your calls confirming their claims and settling their disagreements, then write. Prefer the conventions already in this repo over generic best practice, and keep the plan proportional to the request: if the change is backend/CLI/library with no UI, do NOT invent UI - cover the operator/developer experience instead (logs, errors, flags, migration, backward-compat).${QA_NOTE}${SURFACE_NOTE}

Output ONLY the final Markdown plan. Your VERY FIRST characters must be the heading ## Goal - do NOT write any sentence, acknowledgement, status line, or preamble before it. Use EXACTLY these sections, in this order:
## Goal
## Affected files
## Implementation steps
## Risks & mitigations
## Testing
Make it concrete and ordered so an engineer can execute it top to bottom: real path:line references and exact signatures throughout. In Affected files, list real paths and mark each edit or NEW. In Implementation steps, use verb-first, small, ordered steps naming real symbols. Under Risks & mitigations, give real gotchas with concrete mitigations - not boilerplate. In Testing, use this project's actual test/run setup.${REQUIREMENT_COVERAGE_NOTE}

Do NOT mention the drafts or this process. No praise, no filler, no meta-commentary. Do NOT emit @@CLARIFY@@ and never output an empty or placeholder plan - if inputs conflict, decide and proceed.`;

const HARDEN_FINAL_SYS = `You harden and finalize in one pass: fold the stronger content of plan [B] into plan [A], fix risks and missing steps, and output the final implementation-ready plan.

You have NO access to files, tools, or a shell - never output commands, tool narration, requests to inspect the repo, or anything that implies you can read files. Work strictly from the plan texts; treat their file references as given. Pick the stronger content by quality, not by position: plan [A] is the current primary only because it already looks structurally complete, and plan [B] may still contain better coverage, tests, risks, or sequencing.

HARDENING CHECKLIST: preserve every real path/signature already grounded in the drafts, remove contradictions, add missing integration points when one draft caught them, and make risks/test steps implementation-ready instead of vague. If the drafts disagree, keep the version with more concrete repo evidence and mark any remaining uncertainty as a risk instead of inventing a fact.${QA_NOTE}${SURFACE_NOTE}

Output ONLY the final Markdown plan. Your VERY FIRST characters must be the heading ## Goal - do NOT write any sentence, acknowledgement, status line, or preamble before it. Use EXACTLY these sections, in this order:
## Goal
## Affected files
## Implementation steps
## Risks & mitigations
## Testing
Make it concrete and ordered so an engineer can execute it top to bottom: real path:line references and exact signatures throughout. In Affected files, list real paths and mark each edit or NEW. In Implementation steps, use verb-first, small, ordered steps naming real symbols. Under Risks & mitigations, give real gotchas with concrete mitigations - not boilerplate. In Testing, use this project's actual test/run setup.${REQUIREMENT_COVERAGE_NOTE}

Do NOT mention the drafts or this process. No praise, no filler, no meta-commentary. Do NOT emit @@CLARIFY@@ and never output an empty or placeholder plan - if inputs conflict, decide and proceed.`;

// --- Grounded-mode stage prompts (recon) -------------------------------------
// These stages run WITH folder access (call(..., workdir)) so the model opens
// real files. Each leads with a turn budget because a scoped stage that
// exhausts --max-turns now fail-fasts the run instead of letting unverified
// text masquerade as a grounded plan.
// Recon emits its own titled doc ("# Ground-truth brief"), never the five plan
// sections, so it can't be mistaken for a final plan by writePlan/planSlug.
// VERIFY_SYS stays in the file for per-stage override experiments.

const RECON_SYS = `You are a staff engineer doing RECON on a real codebase in the working directory. Your deliverable is a GROUND-TRUTH BRIEF that the final planner after you will trust as fact. You are NOT writing a plan and NOT proposing changes - you report exactly what exists today so nobody downstream has to guess or invent.

SCOPE DISCIPLINE (critical): You have Read/Glob/Grep and a STRICT budget of about 25 tool calls, and the brief must fit in about 150 lines. If you exhaust the budget, your work is LOST and the whole run degrades. Work like a surgeon, not a tourist: (1) from the request, name the handful of files and symbols most likely involved; (2) use Grep/Glob to LOCATE them by symbol/string name (not broad directory listings), then Read only those files and only the relevant regions of large ones; (3) do NOT crawl the tree, node_modules, lockfiles, or generated output, and do not read the same file twice. Stop as soon as you can write the brief with confidence - unread corners are fine.

VERIFY, NEVER ASSUME: every path, symbol, signature, import, and export you report must come from a file you actually opened this run. Copy signatures verbatim; do not paraphrase them. If the request assumes something exists and you cannot find it, state that explicitly as NOT FOUND: <thing> (searched: <how>) rather than inventing it.${SURFACE_NOTE}

Output a concise Markdown brief titled "# Ground-truth brief" with these headings:
- Request in one line: the concrete change being asked for.
- Relevant files: each real path you opened with a one-line role, e.g. lib/plan.ts:159 runPlan - orchestrates the plan pipeline.
- Key signatures and types: exact function/type/const signatures copied verbatim with path:line, for everything the change will touch or call. Mark anything the request assumes but that does NOT exist as NOT FOUND.
- Integration points: where new code must hook in - the exact call sites, exports, registries, switch/if branches, config keys, or dispatch tables that would need to change, each cited with path:line.
- Named surfaces: the exact file/component implementing each page/dialog/flow the request names, plus every duplicated implementation of that UI (grep for shared labels/components) - one line each with path:line.
- Conventions to follow: patterns THIS repo already uses that a plan must match (error handling, naming, imports, how similar features are wired, punctuation/comment style), each backed by a concrete example location.
- Gotchas and constraints: real traps visible in the code - things already handled so a plan must NOT redo them, invariants that must hold, tool/turn/timeout/sandbox limits, ordering/side-effect hazards, and anything that looks like it exists but does NOT (state the absence explicitly).
- Open unknowns: anything you could not verify within budget, flagged plainly so drafters treat it as unverified rather than fact.

Be dense and factual. No plan, no steps, no recommendations, no praise, no filler. Do NOT emit @@CLARIFY@@ - your job is to report what is, not to ask questions. If the working directory has no readable code, say so in one line and stop.`;

const VERIFY_SYS = `You are a ruthless adversarial FACT-CHECKER with full read access to the REAL code in the working directory. One or more engineers each wrote an implementation-plan draft for the same request. Your ONLY job is to catch everything in those drafts that is false, fabricated, wrong, missing, or unnecessary - by OPENING THE ACTUAL FILES and comparing each claim against reality. You are NOT here to be nice, to rewrite, or to produce a plan of your own. Do not restate the drafts; only flag what is wrong, missing, or wasteful, with proof from the repo.

HOW YOU WORK (non-negotiable): a draft asserting something is NOT evidence - the file is the evidence. For every concrete claim (a file exists, a function has signature X, a symbol is exported, code lives at a path, "X already exists", "Y must change", a step is needed), Grep for the exact symbol, open the file it should be in, and confirm or refute before accepting it. Assume the drafts contain confident hallucinations until proven otherwise - real runs have invented a non-existent file and wrong signatures, and catching exactly that is your entire reason to exist.

SCOPE DISCIPLINE: You have Read/Glob/Grep and a STRICT budget of about 40 tool calls. If you exhaust it, your report is LOST and the fact-check silently vanishes. Be surgical: verify the load-bearing claims FIRST (files to edit, signatures to call, integration points) - a fabrication there poisons the whole plan - and spend the minimum reads on each. Do not re-explore the repo or re-read files needlessly; chase the claims, not the tree. If you run low on budget, spend what remains on the highest-impact claims and mark the rest UNVERIFIED rather than guessing.

Classify each thing you check:
- FABRICATED: the draft references a file/symbol/signature that does not exist. Give the false claim, which draft made it, and the real state ("no such file", or the real path/signature if the draft meant something that does exist).
- WRONG: it exists but the draft describes it incorrectly (wrong signature, path, arg order, return, location, or current behavior). Quote the draft's version and the real version with path:line.
- MISSING: a step the code clearly requires that no draft includes (an integration point, export, call site, config key, or test that must change but was overlooked). Cite the path:line that proves it is needed.
- UNNECESSARY: a step proposed for something already handled, already existing, nonexistent, or scope the request never asked for (e.g. inventing UI for a backend-only change). Cite the code that makes it redundant.
- UNVERIFIED: a claim you could not confirm within budget. List it so the finalizer treats it with caution.

Fact-check each draft's Testing/QA section like any other claim set: a test step that asserts behavior the current code cannot satisfy (a feature that does not exist, a value hardcoded to something else, an endpoint that is absent) is WRONG - cite the code that contradicts it. Untestable QA is how plans ship broken promises.

Output Markdown titled "# Corrections report". Tag every finding with the draft it applies to using [A], [B], or [both], grouped most-severe-first, under these headings: Fabrications and wrong facts; Missing steps; Unnecessary steps; Verified-correct highlights (the key load-bearing claims you checked and confirmed true, so the finalizer has an explicit keep-list, not just a delete-list); and Unverified (if any). Every finding must cite a real path:line you actually opened (except FABRICATED, where you cite the proven absence). If a draft is accurate on a point you checked, say so in one line - confirmation is signal too; a near-empty report that is mostly Verified-correct is a valid, good result.

Do NOT rewrite the drafts, do NOT produce a merged or new plan, and do NOT emit @@CLARIFY@@. Never invent a defect: if you did not open the file, do not claim it is wrong - mark it UNVERIFIED instead.`;

const RECON_FINAL_SYS = `You are the lead engineer producing the ONE definitive, implementation-ready plan. You are given: a ground-truth brief (verified facts about the real repo) and two draft plans. You also have live read access to the real code in the working directory to settle any remaining doubt. In one pass, adversarially fact-check both drafts against the code and the brief, then output the final plan a developer will actually execute. It must be genuinely BETTER than any single draft - correct, right-scoped, and complete - not just a blend.

VERIFY BEFORE YOU ADOPT (non-negotiable): a draft asserting something is NOT evidence - the file is. Treat confident draft claims as suspect until the brief or a targeted Read/Grep proves them. Classify what you find internally with this vocabulary and apply it directly to the plan: FABRICATED means the file/symbol/signature does not exist; WRONG means it exists but the draft described it incorrectly; MISSING means the code clearly requires a step no draft includes; UNNECESSARY means a draft step is already handled, nonexistent, or outside the request; UNVERIFIED means you could not confirm it within budget and must not assert it as fact.

APPLY THE FACT-CHECK as a hard constraint: delete anything FABRICATED or UNNECESSARY, fix anything WRONG to the real path/signature, and add every MISSING step. A refuted claim must NOT survive into the final plan. Where the drafts agree and the code confirms them, keep the stronger phrasing; where they conflict, pick the version the code supports and drop the other. Every file path and symbol in the plan must actually exist, or be an explicitly labeled NEW file with its real integration point from the brief.

Prefer the conventions already in this repo over generic best practice, and keep the plan proportional to the request: if the change is backend/CLI/library with no UI, do NOT invent UI, screens, or user-facing copy - cover the operator/developer experience instead (logs, errors, flags, migration, backward-compat). Proportional cuts must never remove or optional-ize something the request explicitly asked to see - every requested display surface ships by default.${SURFACE_NOTE}

SCOPE DISCIPLINE: You have Read/Glob/Grep and a STRICT budget of about 35 tool calls, but the brief already did the investigation - do NOT re-audit the repo or restart reconnaissance. Open a file ONLY to resolve a specific draft conflict, verify a load-bearing claim missing from the brief, or confirm a requested surface. A solid plan built from the inputs beats an incomplete one that ran out of turns.

Output ONLY the final Markdown plan. Your VERY FIRST characters must be the heading ## Goal - do NOT write any sentence, acknowledgement, status line, or preamble before it. Use EXACTLY these sections, in this order:
## Goal
## Affected files
## Implementation steps
## Risks & mitigations
## Testing
Make it concrete and ordered so an engineer can execute it top to bottom: real path:line references and exact signatures throughout. In Affected files, list real paths and mark each edit or NEW. In Implementation steps, use verb-first, small, ordered steps naming real symbols. Under Risks & mitigations, fold in the real gotchas from the brief and every residual uncertainty, each with a concrete mitigation - not boilerplate. In Testing, use this project's actual test/run setup.${QA_NOTE}${REQUIREMENT_COVERAGE_NOTE}

Do NOT mention the drafts, the brief, the fact-check, or this process. No praise, no filler, no meta-commentary. Do NOT emit @@CLARIFY@@ and never output an empty or placeholder plan - if inputs conflict, decide and proceed.`;


const fence = (s: string) => `\n\n---\n${(s || "").trim()}\n---\n`;

// One model call with a system prompt + the conversation + a stage instruction.
// planMode is always true here: agents may read the project and create plan
// files, but not edit existing source. Fuse also writes the final plan file.
// `session` chains stages into one CLI conversation: pass {id} on the first
// stage and {resume: id} on later ones - the resumed stage keeps every file
// the earlier stage read in context (claude-cli only; see lib/cli.ts).
async function call(
  model: ModelRef,
  system: string,
  base: ChatMessage[],
  instruction: string,
  workdir?: string,
  onActivity?: (info: ActivityInfo) => void,
  session?: CliSession,
  sandbox?: CliSandbox,
  signal?: AbortSignal,
  reasoningEffort?: Effort,
) {
  const messages: ChatMessage[] = [{ role: "system", content: system + FILE_NOTE }, ...base, { role: "user", content: instruction }];
  try {
    const r = await callModel({ provider: model.provider, model: model.model, messages, workdir, planMode: true, onActivity, session, reasoningEffort, sandbox, signal });
    return { content: r.content, usage: r.usage, sessionId: r.sessionId, error: undefined as string | undefined };
  } catch (e: any) {
    return {
      content: "",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      sessionId: undefined as string | undefined,
      error: e?.message ?? String(e),
    };
  }
}

const fmtChars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

// Build a short, descriptive filename slug for a plan. Prefer the plan's own H1
// title (stripping boilerplate like "Implementation Plan:"); fall back to the
// user's request. Returns "" if nothing usable, so the caller can omit it.
function planSlug(markdown: string, hint: string): string {
  const h1 = markdown.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m)?.[1];
  let title = (h1 || "").replace(/^(hardened\s+|final\s+|merged\s+)?(implementation\s+)?plan\b\s*[:\-–—]?\s*/i, "").trim();
  // Final plans are required to start at "## Goal" (no H1), so title from the
  // first line under Goal - otherwise every plan file is named after the raw
  // request text.
  if (!title) {
    const goal = markdown.match(/^\s{0,3}##\s+Goal\b[^\n]*\n+\s*([^\n#][^\n]{0,200})/m)?.[1];
    if (goal) title = goal.trim();
  }
  if (!title) title = hint;
  return (title || "")
    .toLowerCase()
    .replace(/[`*_~>#[\]()]/g, "")   // markdown punctuation
    .replace(/[^a-z0-9]+/g, "-")      // anything else -> hyphen
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

const REQUIRED_PLAN_SECTIONS = ["Goal", "Affected files", "Implementation steps", "Risks & mitigations", "Testing"];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasPlanSections(markdown: string | undefined): boolean {
  if (!markdown?.trim()) return false;
  if (!markdown.startsWith("## Goal")) return false;
  let from = 0;
  for (const section of REQUIRED_PLAN_SECTIONS) {
    const re = new RegExp(`^\\s{0,3}##\\s+${escapeRegExp(section)}\\b`, "gim");
    re.lastIndex = from;
    const match = re.exec(markdown);
    if (!match) return false;
    from = match.index + match[0].length;
  }
  return true;
}

export function bestDraftFallback(a: string, b: string): string {
  if (hasPlanSections(a)) return a;
  if (hasPlanSections(b)) return b;
  return a || b;
}

export function withDegradedWarning(degraded: string, final: string): string {
  return (
    `> **WARNING (Fuse):** the ${degraded} stage failed to produce a complete final plan even after a retry, so this file is the strongest UNVERIFIED draft - not a verified plan. Double-check its file paths and claims before implementing.\n\n` +
    final
  );
}

const codexClosingSandbox = (model: ModelRef): CliSandbox | undefined =>
  model.provider === "codex-cli" ? "read-only" : undefined;

const sameModelRef = (x: ModelRef, y: ModelRef) => x.provider === y.provider && x.model === y.model;

async function writePlan(markdown: string, workdir: string | undefined, hint: string): Promise<string> {
  const dir = workdir && existsSync(workdir) ? workdir : path.join(DATA_DIR, "plans");
  await fs.mkdir(dir, { recursive: true });
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const slug = planSlug(markdown, hint);
  // Descriptive name (e.g. fuse-plan-add-dark-mode-toggle-20260701-001230.md);
  // the timestamp keeps it unique. Falls back to just the stamp if no slug.
  const name = `fuse-plan-${slug ? slug + "-" : ""}${stamp}.md`;
  const full = path.join(dir, name);
  await fs.writeFile(full, markdown, "utf8");
  return full;
}

export async function runPlan(
  messages: ChatMessage[],
  proposers: ModelRef[],
  aggregator: ModelRef,
  mode: PlanMode,
  workdir?: string,
  onProgress?: ProgressFn,
  onStage?: (stages: StageInfo[]) => void,
  stageModels: StageModelMap = {},
  signal?: AbortSignal,
): Promise<PlanResult> {
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    return await runPlanInner(messages, proposers, aggregator, mode, workdir, onProgress, onStage, stageModels, signal, ac);
  } finally {
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

async function runPlanInner(
  messages: ChatMessage[],
  proposers: ModelRef[],
  aggregator: ModelRef,
  mode: PlanMode,
  workdir: string | undefined,
  onProgress: ProgressFn | undefined,
  onStage: ((stages: StageInfo[]) => void) | undefined,
  stageModels: StageModelMap,
  outerSignal: AbortSignal | undefined,
  ac: AbortController,
): Promise<PlanResult> {
  const usageItems: UsageItem[] = [];
  const proposals: Proposal[] = [];
  const a = proposers[0];
  const b = proposers[1] ?? proposers[0];
  const roleFor: Record<StageKey, ModelRef> = {
    clarify: a,
    recon: aggregator,
    draftA: a,
    draftB: b,
    harden: b,
    verify: aggregator,
    synthesize: aggregator,
    finalize: aggregator,
  };
  const modelFor = (key: StageKey): ModelRef => stageModels[key] ?? roleFor[key];
  const clarifyModel = modelFor("clarify");
  const reconModel = modelFor("recon");
  const draftAModel = modelFor("draftA");
  const draftBModel = modelFor("draftB");
  const finalizeModel = modelFor("finalize");
  const canChainReconSession = reconModel.provider === "claude-cli" && sameModelRef(reconModel, finalizeModel);
  // The latest user message - used as a fallback for the plan filename.
  const request = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  // Snapshot the folder so we can report any files the agents create.
  const beforeFiles = workdir && existsSync(workdir) ? listFiles(workdir) : null;

  const makeStage = (
    key: StageKey,
    title: string,
    model: ModelRef,
  ): StageInfo => ({
    key,
    title,
    provider: model.provider,
    model: model.model,
    status: "pending",
  });
  const stages: StageInfo[] =
    mode === "fast"
      ? [
          makeStage("draftA", `Draft · ${draftAModel.provider} ${draftAModel.model}`, draftAModel),
          makeStage("draftB", `Draft · ${draftBModel.provider} ${draftBModel.model}`, draftBModel),
          makeStage("finalize", "Verify & finalize", finalizeModel),
        ]
      : mode === "relay"
        ? [
            makeStage("draftA", `Draft · ${draftAModel.provider} ${draftAModel.model}`, draftAModel),
            makeStage("draftB", `Draft · ${draftBModel.provider} ${draftBModel.model}`, draftBModel),
            makeStage("finalize", "Harden & finalize", finalizeModel),
          ]
      : [
          makeStage("clarify", `Clarify · ${clarifyModel.provider} ${clarifyModel.model}`, clarifyModel),
          makeStage("recon", "Recon", reconModel),
          makeStage("draftA", `Draft · ${draftAModel.provider} ${draftAModel.model}`, draftAModel),
          makeStage("draftB", `Draft · ${draftBModel.provider} ${draftBModel.model}`, draftBModel),
          makeStage("finalize", "Verify & finalize", finalizeModel),
        ];
  const emitStages = (outputKey?: string) => {
    onStage?.(
      stages.map((s) => {
        const out = { ...s };
        if (out.output !== undefined && out.key !== outputKey) delete out.output;
        return out;
      }),
    );
  };
  const stage = (key: StageKey, patch: Partial<StageInfo>) => {
    const s = stages.find((x) => x.key === key);
    if (!s) return;
    const now = Date.now();
    const nextStatus = patch.status;
    if (nextStatus === "running" && s.status !== "running") {
      s.startedAt ??= now;
      delete s.endedAt;
    }
    Object.assign(s, patch);
    if ((nextStatus === "done" || nextStatus === "error" || nextStatus === "skipped") && !s.endedAt) {
      s.endedAt = now;
    }
    emitStages(Object.prototype.hasOwnProperty.call(patch, "output") ? key : undefined);
  };
  const skipPendingStages = () => {
    for (const s of stages) {
      if (s.status === "pending") stage(s.key as StageKey, { status: "skipped" });
    }
  };
  const stageTitleOf = (key: StageKey) => (stages.find((s) => s.key === key)?.title ?? key).split(" · ")[0];
  const isRunStoppedMessage = (msg: string | undefined) => !!msg && /^Run stopped\.?$/i.test(msg.trim());
  const assertNotStopped = () => {
    if (!outerSignal?.aborted) return;
    skipPendingStages();
    throw new RunStoppedError(usageItems);
  };
  const failStage = (key: StageKey, model: ModelRef, msg: string): never => {
    ac.abort();
    skipPendingStages();
    throw new AgentFailedError(stageTitleOf(key), `${model.provider}/${model.model}`, msg, usageItems);
  };
  emitStages();

  // fast: drafts(2) + verify-finalize = 3. relay: drafts(2) +
  // harden-finalize = 3. recon: recon + drafts(2) + verify-finalize = 4
  // (recon's clarify pre-check runs in parallel and is not counted).
  const total = mode === "recon" ? 4 : 3;
  let done = 0;
  const bump = (label: string, ag?: AgentStatus[]) => {
    done++;
    onProgress?.(done, total, label, ag);
  };

  // Throttled liveness: while a slow stage streams, refresh its progress label
  // with how much it has produced so the user can see it's actively working -
  // not stuck - even when a single stage runs for many minutes. The throttle is
  // per-stage (one closure each) so stages can't starve one another.
  const stageEmitAt = new Map<string, number>();
  const stageActivity = (key: StageKey, info: ActivityInfo) => {
    const now = Date.now();
    if (now - (stageEmitAt.get(key) ?? 0) < 700) return;
    stageEmitAt.set(key, now);
    stage(key, { chars: info.chars, tail: info.tail });
  };
  const makeActivity = (base: string, key?: StageKey) => {
    let lastEmit = 0;
    return (info: ActivityInfo) => {
      const now = Date.now();
      if (now - lastEmit < 700) return;
      lastEmit = now;
      onProgress?.(done, total, `${base} · ${fmtChars(info.chars)} streamed`);
      if (key) stageActivity(key, info);
    };
  };

  // Record a stage as a proposal (stage shown in the model label for the debug view).
  const record = (
    model: ModelRef,
    stage: string,
    r: { content: string; usage: any; error?: string; sessionId?: string },
    role: UsageItem["role"],
  ) => {
    proposals.push({
      provider: model.provider,
      model: `${model.model} · ${stage}`,
      content: r.content,
      error: r.error,
      errorInfo: r.error
        ? classifyCliError(r.error, {
            stage,
            provider: model.provider === "claude-cli" ? "claude" : model.provider === "codex-cli" ? "codex" : undefined,
            providerModel: `${model.provider}/${model.model}`,
          })
        : undefined,
      usage: r.usage,
    });
    if (!r.error) {
      usageItems.push({
        provider: model.provider,
        model: model.model,
        role,
        ...r.usage,
        cost: estimateCost(model.model, r.usage.prompt_tokens, r.usage.completion_tokens),
        sessionId: r.sessionId,
      });
    }
  };

  // Deduplicate clarify questions (case/space-insensitive) wherever they come from.
  const dedupeQuestions = (qs: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const q of qs) {
      const key = q.toLowerCase().replace(/\s+/g, " ").trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(q);
      }
    }
    return out;
  };
  const clarifyResult = (questions: string[]): PlanResult => ({
    final:
      "**Before I draft the plan, I need a bit more info:**\n\n" +
      questions.map((q, i) => `${i + 1}. ${q}`).join("\n") +
      "\n\nAnswer these and I'll produce the full plan.",
    proposals,
    usageItems,
    planPath: "",
    needsClarification: true,
    questions,
  });

  // Recon's first wave overlaps the cheap clarify screen, the grounded recon
  // brief, and both independent drafts. If clarify finds real blocking
  // questions, abort the in-flight work and return those questions; otherwise
  // the wall clock is dominated by the slowest of recon/drafts instead of their
  // sum.
  let brief = "";
  let sessionId: string | undefined;
  let abortForClarify = false;

  const clarifyPromise =
    mode === "recon"
      ? (async () => {
          stage("clarify", { status: "running" });
          onProgress?.(done, total, "Screening request while planning starts…");
          const chk = await call(
            clarifyModel,
            CLARIFY_CHECK_SYS,
            messages,
            "Screen the request above. Reply with @@CLARIFY@@ [...] or NO.",
            undefined,
            undefined,
            undefined,
            undefined,
            ac.signal,
          );
          const questions = chk.error ? [] : dedupeQuestions(extractQuestions(chk.content));
          if (questions.length > 0) {
            abortForClarify = true;
            ac.abort();
          }
          stage("clarify", { status: chk.error ? "error" : "done", output: chk.content, error: chk.error });
          if (!chk.error) record(clarifyModel, "clarify check", chk, "proposer");
          return { check: chk, questions };
        })()
      : undefined;

  // Recon pre-stage (recon mode only): one strong model investigates the real
  // code and produces a ground-truth brief the finalizer uses as a verified
  // keep-list. The stage is pinned to a pre-generated session UUID so the
  // finalizer can RESUME it: the resumed stage keeps every file recon read in
  // context instead of re-reading the repo cold. Chaining needs claude-cli
  // (codex resume isn't wired); with another aggregator we fall back fresh.
  const reconPromise =
    mode === "recon"
      ? (async () => {
          if (!canChainReconSession) {
            onProgress?.(done, total, "Recon finalizer uses a different model; final stage will run fresh…");
          }
          const pinned = canChainReconSession && reconModel.provider === "claude-cli" ? randomUUID() : undefined;
          const sandbox = codexClosingSandbox(reconModel);
          stage("recon", { status: "running" });
          onProgress?.(done, total, "Reconning the codebase in parallel…");
          const rec = await call(
            reconModel,
            RECON_SYS,
            messages,
            "Investigate the actual project in the working directory and produce the ground-truth brief for the request above. Return the brief as your response only; do not create any files.",
            workdir,
            makeActivity("Reconning the codebase in parallel…", "recon"),
            pinned ? { id: pinned } : undefined,
            sandbox,
            ac.signal,
          );
          const skipped = abortForClarify && !!rec.error;
          if (rec.error && !abortForClarify) ac.abort();
          stage("recon", {
            status: skipped ? "skipped" : rec.error ? "error" : "done",
            output: skipped ? undefined : rec.content,
            error: skipped ? undefined : rec.error,
          });
          if (!skipped) {
            bump("Recon ready");
            record(reconModel, "recon", rec, "aggregator");
          }
          brief = rec.content?.trim() || "";
          // Only chain if recon really persisted under our UUID (the CLI echoes it).
          if (!rec.error && brief && pinned && rec.sessionId === pinned) sessionId = pinned;
          return rec;
        })()
      : undefined;

  // Stage 1 - independent drafts (all modes), in parallel. Both run scoped
  // (workdir) so they read the real project. Recon mode deliberately does NOT
  // seed them with the brief; independent fresh exploration avoids anchoring on
  // a single recon interpretation, while the finalizer consumes the brief.
  const agents: AgentStatus[] = [draftAModel, draftBModel].map((m) => ({ model: m.model, status: "running" as const }));
  const snap = () => agents.map((x) => ({ ...x }));
  stage("draftA", { status: "running" });
  stage("draftB", { status: "running" });
  onProgress?.(done, total, "2 agents drafting in parallel…", snap());
  // Combined liveness for the (often longest) draft stage: chars streamed per
  // agent, throttled like every other stage's heartbeat.
  const draftChars = [0, 0];
  let draftEmit = 0;
  const draftActivity = (idx: number) => (info: ActivityInfo) => {
    stageActivity(idx === 0 ? "draftA" : "draftB", info);
    draftChars[idx] = info.chars;
    const now = Date.now();
    if (now - draftEmit < 700) return;
    draftEmit = now;
    onProgress?.(
      done,
      total,
      `2 agents drafting in parallel… · ${draftAModel.model} ${fmtChars(draftChars[0])} / ${draftBModel.model} ${fmtChars(draftChars[1])} streamed`,
      snap(),
    );
  };
  const draftInstruction = "Write the implementation plan for the request above.";
  const draftsPromise = Promise.all([
    call(draftAModel, DRAFT_SYS, messages, draftInstruction, workdir, draftActivity(0), undefined, undefined, ac.signal).then((r) => {
      const skipped = abortForClarify && !!r.error;
      if (r.error && !abortForClarify) ac.abort();
      agents[0].status = r.error ? "error" : "done";
      stage("draftA", {
        status: skipped ? "skipped" : r.error ? "error" : "done",
        output: skipped ? undefined : r.content,
        error: skipped ? undefined : r.error,
      });
      if (!skipped) bump("Draft ready", snap());
      return r;
    }),
    call(draftBModel, DRAFT_SYS, messages, draftInstruction, workdir, draftActivity(1), undefined, undefined, ac.signal).then((r) => {
      const skipped = abortForClarify && !!r.error;
      if (r.error && !abortForClarify) ac.abort();
      agents[1].status = r.error ? "error" : "done";
      stage("draftB", {
        status: skipped ? "skipped" : r.error ? "error" : "done",
        output: skipped ? undefined : r.content,
        error: skipped ? undefined : r.error,
      });
      if (!skipped) bump("Draft ready", snap());
      return r;
    }),
  ]);

  if (clarifyPromise) {
    const chk = await clarifyPromise;
    assertNotStopped();
    if (chk.questions.length > 0) {
      await Promise.allSettled([reconPromise, draftsPromise]);
      skipPendingStages();
      return clarifyResult(chk.questions);
    }
  }

  const [rec, draftResults] = await Promise.all([reconPromise ?? Promise.resolve(undefined), draftsPromise]);
  const [da, db] = draftResults;
  record(draftAModel, "draft A", da, "proposer");
  record(draftBModel, "draft B", db, "proposer");
  assertNotStopped();
  const reconFailure = rec?.error && !isRunStoppedMessage(rec.error) ? rec.error : null;
  if (reconFailure) failStage("recon", reconModel, reconFailure);
  const draftFailure =
    da.error && !isRunStoppedMessage(da.error)
      ? { key: "draftA" as StageKey, model: draftAModel, error: da.error }
      : db.error && !isRunStoppedMessage(db.error)
        ? { key: "draftB" as StageKey, model: draftBModel, error: db.error }
        : da.error
          ? { key: "draftA" as StageKey, model: draftAModel, error: da.error }
          : db.error
            ? { key: "draftB" as StageKey, model: draftBModel, error: db.error }
            : null;
  if (draftFailure) failStage(draftFailure.key, draftFailure.model, draftFailure.error);
  if (rec?.error) failStage("recon", reconModel, rec.error);

  // If any agent is genuinely blocked, consolidate questions and pause for the
  // user instead of planning.
  const questions = dedupeQuestions([...extractQuestions(da.content), ...extractQuestions(db.content)]);
  if (questions.length > 0) {
    skipPendingStages();
    return clarifyResult(questions);
  }

  let final: string;
  // Set when the closing stage did not produce a complete final plan even after
  // retry, so we fell back to an unverified draft instead of silently shipping it.
  let degraded: string | null = null;

  if (mode === "fast") {
    // Single closing stage: verify the drafts' load-bearing claims against the
    // source, merge the stronger content, finalize. One grounded pass.
    const finIns = `Draft [A]:${fence(da.content)}\nDraft [B]:${fence(db.content)}\nVerify the load-bearing claims against the real code, then produce the final implementation-ready plan. Output the plan as your response only; do not create any files.`;
    stage("finalize", { status: "running" });
    onProgress?.(done, total, "Verifying and finalizing…");
    const sandbox = codexClosingSandbox(finalizeModel);
    let fin = await call(
      finalizeModel,
      FAST_FINAL_SYS,
      messages,
      finIns,
      workdir,
      makeActivity("Verifying and finalizing…", "finalize"),
      undefined,
      sandbox,
      ac.signal,
    );
    if (fin.error || !hasPlanSections(fin.content)) {
      onProgress?.(done, total, "Verifying and finalizing… (retry)");
      fin = await call(
        finalizeModel,
        FAST_FINAL_SYS,
        messages,
        finIns,
        workdir,
        makeActivity("Verifying and finalizing… (retry)", "finalize"),
        undefined,
        sandbox,
        ac.signal,
      );
    }
    bump("Done");
    record(finalizeModel, "verify-finalize", fin, "aggregator");
    if (fin.error) stage("finalize", { status: "error", output: fin.content, error: fin.error });
    assertNotStopped();
    if (fin.error) failStage("finalize", finalizeModel, fin.error);
    final = fin.content;
    if (!hasPlanSections(final)) {
      degraded = "verify-finalize";
      final = bestDraftFallback(da.content, db.content);
      stage("finalize", {
        status: "error",
        output: fin.content,
        error: fin.error ?? "Failed to produce a complete final plan.",
      });
    } else {
      stage("finalize", { status: fin.error ? "error" : "done", output: fin.content, error: fin.error });
    }
  } else if (mode === "relay") {
    // Relay stays blind after the drafts: the finalizer hardens and finalizes
    // from plan text only, with an explicit no-tools contract in the prompt.
    const primary = hasPlanSections(da.content) ? da : db;
    const alternative = primary === da ? db : da;
    const finIns = `Plan [A] - primary draft to harden and finalize:${fence(primary.content)}\nPlan [B] - alternative draft to mine for stronger content:${fence(alternative.content)}\nProduce the final implementation-ready plan.`;
    stage("finalize", { status: "running" });
    onProgress?.(done, total, "Hardening and finalizing…");
    let fin = await call(
      finalizeModel,
      HARDEN_FINAL_SYS,
      messages,
      finIns,
      undefined,
      makeActivity("Hardening and finalizing…", "finalize"),
      undefined,
      undefined,
      ac.signal,
      "medium",
    );
    if (fin.error || !hasPlanSections(fin.content)) {
      onProgress?.(done, total, "Hardening and finalizing… (retry)");
      fin = await call(
        finalizeModel,
        HARDEN_FINAL_SYS,
        messages,
        finIns,
        undefined,
        makeActivity("Hardening and finalizing… (retry)", "finalize"),
        undefined,
        undefined,
        ac.signal,
        "medium",
      );
    }
    bump("Done");
    record(finalizeModel, "harden-finalize", fin, "aggregator");
    if (fin.error) stage("finalize", { status: "error", output: fin.content, error: fin.error });
    assertNotStopped();
    if (fin.error) failStage("finalize", finalizeModel, fin.error);
    final = fin.content;
    if (!hasPlanSections(final)) {
      degraded = "finalize";
      final = bestDraftFallback(da.content, db.content);
      stage("finalize", {
        status: "error",
        output: fin.content,
        error: fin.error ?? "Failed to produce a complete final plan.",
      });
    } else {
      stage("finalize", { status: fin.error ? "error" : "done", output: fin.content, error: fin.error });
    }
  } else {
    const sandbox = codexClosingSandbox(finalizeModel);
    const freshInstruction = `Ground-truth brief:${fence(brief)}\nDraft [A]:${fence(da.content)}\nDraft [B]:${fence(db.content)}\nFact-check both drafts against the brief and the real code, then produce the final, verified, implementation-ready plan. Output the plan as your response only; do not create any files.`;
    const freshFinal = (label: string) =>
      call(
        finalizeModel,
        RECON_FINAL_SYS,
        messages,
        freshInstruction,
        workdir,
        makeActivity(label, "finalize"),
        undefined,
        sandbox,
        ac.signal,
      );

    stage("finalize", { status: "running" });
    onProgress?.(done, total, "Fact-checking and finalizing…");
    let fin = sessionId
      ? await call(
          finalizeModel,
          RECON_FINAL_SYS,
          [], // the resumed session already holds the conversation + brief
          `You already produced the ground-truth brief above - treat it as your verified keep-list and spend your budget on draft claims it does not settle.\n\nDraft [A]:${fence(da.content)}\nDraft [B]:${fence(db.content)}\nFact-check both drafts against the code already in context, then produce the final, verified, implementation-ready plan. Output the plan as your response only; do not create any files.`,
          workdir,
          makeActivity("Fact-checking and finalizing…", "finalize"),
          { resume: sessionId },
          sandbox,
          ac.signal,
        )
      : await freshFinal("Fact-checking and finalizing…");
    if (fin.error || !hasPlanSections(fin.content)) {
      onProgress?.(done, total, sessionId ? "Fact-checking and finalizing… (fresh fallback)" : "Fact-checking and finalizing… (retry)");
      fin = await freshFinal(sessionId ? "Fact-checking and finalizing… (fresh fallback)" : "Fact-checking and finalizing… (retry)");
    }
    bump("Done");
    record(finalizeModel, "recon-finalize", fin, "aggregator");
    if (fin.error) stage("finalize", { status: "error", output: fin.content, error: fin.error });
    assertNotStopped();
    if (fin.error) failStage("finalize", finalizeModel, fin.error);
    final = fin.content;
    if (!hasPlanSections(final)) {
      degraded = "finalize";
      final = bestDraftFallback(da.content, db.content);
      stage("finalize", {
        status: "error",
        output: fin.content,
        error: fin.error ?? "Failed to produce a complete final plan.",
      });
    } else {
      stage("finalize", { status: fin.error ? "error" : "done", output: fin.content, error: fin.error });
    }
  }

  assertNotStopped();
  if (degraded) {
    // Never pass an unverified draft off as a verified plan.
    final = withDegradedWarning(degraded, final);
    onProgress?.(done, total, "Done - fell back to an unverified draft");
  }

  const planPath = await writePlan(final, workdir, request);

  // The canonical plan file + anything the agents created during the run.
  // Plan docs OTHER than our own are excluded: concurrent runs share folders,
  // and another run's fuse-plan-*.md appearing mid-run is not ours to attach.
  const files = new Set<string>([planPath]);
  if (workdir && beforeFiles && existsSync(workdir)) {
    const after = listFiles(workdir);
    if (after)
      for (const f of after)
        if (!beforeFiles.has(f) && (f === planPath || !path.basename(f).startsWith("fuse-plan-"))) files.add(f);
  }

  return { final, proposals, usageItems, planPath, files: [...files] };
}
