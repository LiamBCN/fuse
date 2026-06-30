// Plan Mode pipelines. Two models (the configured proposers) draft and harden
// an implementation plan, then the aggregator produces the final plan. The
// result is written to a Markdown file (in the working folder if set).
//
// fast (A):  draft ∥  →  cross-review ∥  →  synthesize
// advanced (B): draft ∥  →  one model hardens the other's  →  aggregator finalizes
import { promises as fs } from "fs";
import { existsSync, readdirSync } from "fs";
import path from "path";
import { callModel, type ChatMessage } from "./providers";
import { estimateCost } from "./models";
import { DATA_DIR } from "./db";
import type { AgentStatus, ProgressFn } from "./moa";
import type { ModelRef, Proposal } from "./types";
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
  " You MAY create Markdown/notes/scratch files in the working directory to help craft the plan (e.g. plan docs, " +
  "checklists, diagrams). Do NOT modify existing source files, refactor, or implement the feature - your deliverable " +
  "is the plan, not code changes.";

const DRAFT_SYS =
  "You are a senior software engineer creating an IMPLEMENTATION PLAN (do not write the full code). " +
  "Strongly prefer to make reasonable assumptions (state them clearly) and write the plan. ONLY if you genuinely cannot " +
  "produce a useful plan without specific information from the USER that you cannot assume or find in the project, respond " +
  'with NOTHING except a line: @@CLARIFY@@ followed by a JSON array of short question strings, e.g. @@CLARIFY@@ ["Which database is used?", "Should it support multiple users?"]. ' +
  "If a project is available in the working directory, inspect the relevant files first and reference real paths. " +
  "Produce a thorough, concrete, step-by-step plan in GitHub-flavored Markdown with sections: " +
  "## Goal, ## Affected files, ## Implementation steps, ## Risks & mitigations, ## Testing. Output only the Markdown plan.";

const REVIEW_SYS =
  "You are reviewing a peer's implementation plan against your own. Find gaps, risks, and missing steps, then output an " +
  "improved MERGED plan that combines the best of both and resolves the risks. Output only the Markdown plan.";

const SYNTH_SYS =
  "You are the lead engineer. Merge the plans below into a single, definitive, implementation-ready plan. " +
  "Resolve conflicts, eliminate blocking risks, and keep it concrete with real file paths. Output only the final Markdown plan.";

const HARDEN_SYS =
  "You are hardening another engineer's implementation plan. Identify risks, edge cases, and missing steps; fold in anything " +
  "stronger from the alternative plan; output a hardened Markdown plan. Output only the plan.";

const FINAL_SYS =
  "You are the lead engineer producing the FINAL, implementation-ready plan. Compare the hardened plan with the original " +
  "approach, think carefully about remaining risks and edge cases, and resolve every blocking risk so it is safe to implement " +
  "with minimal surprises. Keep it concrete with real file paths. Output only the final Markdown plan.";

const fence = (s: string) => `\n\n---\n${(s || "").trim()}\n---\n`;

// One model call with a system prompt + the conversation + a stage instruction.
// planMode is always true here: agents may read the project and create plan
// files, but not edit existing source. Fuse also writes the final plan file.
async function call(
  model: ModelRef,
  system: string,
  base: ChatMessage[],
  instruction: string,
  workdir?: string,
  onActivity?: (info: { chars: number }) => void,
) {
  const messages: ChatMessage[] = [{ role: "system", content: system + FILE_NOTE }, ...base, { role: "user", content: instruction }];
  try {
    const r = await callModel({ provider: model.provider, model: model.model, messages, workdir, planMode: true, onActivity });
    return { content: r.content, usage: r.usage, error: undefined as string | undefined };
  } catch (e: any) {
    return { content: "", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, error: e?.message ?? String(e) };
  }
}

const fmtChars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

// Build a short, descriptive filename slug for a plan. Prefer the plan's own H1
// title (stripping boilerplate like "Implementation Plan:"); fall back to the
// user's request. Returns "" if nothing usable, so the caller can omit it.
function planSlug(markdown: string, hint: string): string {
  const h1 = markdown.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m)?.[1];
  let title = (h1 || "").replace(/^(hardened\s+|final\s+|merged\s+)?(implementation\s+)?plan\b\s*[:\-–—]?\s*/i, "").trim();
  if (!title) title = hint;
  return (title || "")
    .toLowerCase()
    .replace(/[`*_~>#[\]()]/g, "")   // markdown punctuation
    .replace(/[^a-z0-9]+/g, "-")      // anything else -> hyphen
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

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
  mode: "attack" | "relay",
  workdir?: string,
  onProgress?: ProgressFn,
): Promise<PlanResult> {
  const usageItems: UsageItem[] = [];
  const proposals: Proposal[] = [];
  const a = proposers[0];
  const b = proposers[1] ?? proposers[0];
  // The latest user message - used as a fallback for the plan filename.
  const request = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  // Snapshot the folder so we can report any files the agents create.
  const beforeFiles = workdir && existsSync(workdir) ? listFiles(workdir) : null;

  const total = mode === "attack" ? 5 : 4;
  let done = 0;
  const bump = (label: string, ag?: AgentStatus[]) => {
    done++;
    onProgress?.(done, total, label, ag);
  };

  // Throttled liveness: while a slow stage streams, refresh its progress label
  // with how much it has produced so the user can see it's actively working -
  // not stuck - even when a single stage runs for many minutes.
  let lastEmit = 0;
  const makeActivity = (base: string) => (info: { chars: number }) => {
    const now = Date.now();
    if (now - lastEmit < 700) return;
    lastEmit = now;
    onProgress?.(done, total, `${base} · ${fmtChars(info.chars)} streamed`);
  };

  // Record a stage as a proposal (stage shown in the model label for the debug view).
  const record = (model: ModelRef, stage: string, r: { content: string; usage: any; error?: string }, role: UsageItem["role"]) => {
    proposals.push({ provider: model.provider, model: `${model.model} · ${stage}`, content: r.content, error: r.error, usage: r.usage });
    if (!r.error) {
      usageItems.push({ provider: model.provider, model: model.model, role, ...r.usage, cost: estimateCost(model.model, r.usage.prompt_tokens, r.usage.completion_tokens) });
    }
  };

  // Stage 1 - independent drafts (both modes), in parallel.
  const agents: AgentStatus[] = [a, b].map((m) => ({ model: m.model, status: "running" as const }));
  const snap = () => agents.map((x) => ({ ...x }));
  onProgress?.(0, total, "2 agents drafting in parallel…", snap());
  const [da, db] = await Promise.all([
    call(a, DRAFT_SYS, messages, "Write the implementation plan for the request above.", workdir).then((r) => {
      agents[0].status = r.error ? "error" : "done";
      bump("Draft ready", snap());
      return r;
    }),
    call(b, DRAFT_SYS, messages, "Write the implementation plan for the request above.", workdir).then((r) => {
      agents[1].status = r.error ? "error" : "done";
      bump("Draft ready", snap());
      return r;
    }),
  ]);
  record(a, "draft A", da, "proposer");
  record(b, "draft B", db, "proposer");

  // If any agent is genuinely blocked, consolidate questions and pause for the
  // user instead of planning.
  const seen = new Set<string>();
  const questions: string[] = [];
  for (const q of [...extractQuestions(da.content), ...extractQuestions(db.content)]) {
    const key = q.toLowerCase().replace(/\s+/g, " ").trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      questions.push(q);
    }
  }
  if (questions.length > 0) {
    const final =
      "**Before I draft the plan, I need a bit more info:**\n\n" +
      questions.map((q, i) => `${i + 1}. ${q}`).join("\n") +
      "\n\nAnswer these and I'll produce the full plan.";
    return { final, proposals, usageItems, planPath: "", needsClarification: true, questions };
  }

  let final: string;

  if (mode === "attack") {
    // Stage 2 - cross-review: each improves using the other's draft.
    onProgress?.(done, total, "Cross-critiquing plans…");
    const [ra, rb] = await Promise.all([
      call(a, REVIEW_SYS, messages, `A peer proposed this plan for the same request:${fence(db.content)}\nProduce the improved merged plan.`).then((r) => (bump("Critique ready"), r)), // no workdir: reason over the drafts, don't re-scan the repo
      call(b, REVIEW_SYS, messages, `A peer proposed this plan for the same request:${fence(da.content)}\nProduce the improved merged plan.`).then((r) => (bump("Critique ready"), r)), // no workdir: reason over the drafts, don't re-scan the repo
    ]);
    record(a, "review of B", ra, "proposer");
    record(b, "review of A", rb, "proposer");

    // Stage 3 - synthesize the two reviewed plans.
    onProgress?.(done, total, "Synthesizing final plan…");
    const syn = await call(
      aggregator,
      SYNTH_SYS,
      messages,
      `Reviewed plans:\n\n## Plan 1${fence(ra.content || da.content)}\n## Plan 2${fence(rb.content || db.content)}\nProduce the final implementation-ready plan.`,
      undefined,
      makeActivity("Synthesizing final plan…"),
    );
    bump("Done");
    record(aggregator, "synthesize", syn, "aggregator");
    final = syn.content || ra.content || rb.content || da.content || db.content;
  } else {
    // Advanced (relay): b hardens a's draft (with b's draft for reference),
    // then the aggregator finalizes, comparing with the original.
    onProgress?.(done, total, "Hardening the plan…");
    const hardened = await call(
      b,
      HARDEN_SYS,
      messages,
      `Primary plan to harden:${fence(da.content)}\nAlternative plan for reference:${fence(db.content)}\nProduce the hardened plan.`,
      undefined,
      makeActivity("Hardening the plan…"),
    );
    bump("Hardened");
    record(b, "harden A", hardened, "proposer");

    onProgress?.(done, total, "Finalizing the plan…");
    const finalized = await call(
      aggregator,
      FINAL_SYS,
      messages,
      `Hardened plan:${fence(hardened.content || da.content)}\nOriginal approach:${fence(da.content)}\nProduce the final implementation-ready plan.`,
      undefined,
      makeActivity("Finalizing the plan…"),
    );
    bump("Done");
    record(aggregator, "finalize", finalized, "aggregator");
    final = finalized.content || hardened.content || da.content || db.content;
  }

  if (!final?.trim()) {
    const errs = proposals.filter((p) => p.error).map((p) => `- ${p.provider}/${p.model}: ${p.error}`).join("\n");
    final = `Plan Mode failed - every stage errored:\n\n${errs || "(no output)"}`;
  }

  const planPath = await writePlan(final, workdir, request);

  // The canonical plan file + anything the agents created during the run.
  const files = new Set<string>([planPath]);
  if (workdir && beforeFiles && existsSync(workdir)) {
    const after = listFiles(workdir);
    if (after) for (const f of after) if (!beforeFiles.has(f)) files.add(f);
  }

  return { final, proposals, usageItems, planPath, files: [...files] };
}
