// Publish finished benchmark runs to git so results are versioned, reviewable in
// PRs, and visible to everyone who pulls the Fuse repo. A published run is a
// sanitized JSON record + a human-readable markdown summary under
// `bench/results/<taskId>/`, plus a tiny `index.json` manifest. This module
// deliberately does NOT import bench-store (bench-store imports us for the shared
// merge) — callers persist the run's `published` state themselves.
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { DATA_DIR } from "./db";
import { readSettings } from "./settings-store";
import { contenderLabel } from "./bench-types";
import type { BenchPublishState, BenchRun } from "./bench-types";
import type { FuseConfig } from "./types";

const execFile = promisify(execFileCb);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout, stderr } = await execFile("git", args, {
    cwd,
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  return `${stdout}${stderr}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function gitToplevel(dir: string): Promise<string | null> {
  try {
    const out = (await git(["-C", dir, "rev-parse", "--show-toplevel"])).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Where published results live. An explicit `benchResultsRepo` setting wins
// (validated to a real git checkout). When running `next dev` (no packaged
// FUSE_DATA_DIR), the Fuse checkout is the cwd, so use it. The packaged app has
// no repo, so an unset setting resolves to null and publishing is a no-op.
export async function resolveBenchResultsRepo(cfg?: FuseConfig): Promise<string | null> {
  const config = cfg ?? (await readSettings());
  const configured = config.benchResultsRepo?.trim();
  if (configured) return gitToplevel(configured);
  if (!process.env.FUSE_DATA_DIR) return gitToplevel(process.cwd());
  return null;
}

function safeSeg(seg: string): string {
  return seg.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

// A finished run's logical completion time — stable regardless of later publish
// bookkeeping, so re-exporting the same run is byte-identical (idempotent).
function stableUpdatedAt(run: BenchRun): number {
  let t = run.createdAt;
  for (const r of run.results) if (r.endedAt && r.endedAt > t) t = r.endedAt;
  for (const p of run.judgePasses) if (p.endedAt && p.endedAt > t) t = p.endedAt;
  return t;
}

// Strip absolute machine paths (workdir/snapshot/home/data) and local-only
// bookkeeping so the export is shareable and stable. `<workdir>` stands in for
// the snapshot folder everywhere it appears (config + outputs + judge notes).
export function sanitizeRun(run: BenchRun): BenchRun {
  const clone: BenchRun = JSON.parse(JSON.stringify(run));
  delete clone.published;
  delete clone.publishError;
  delete clone.shared;
  clone.updatedAt = stableUpdatedAt(run);

  const subs: Array<[string, string]> = [];
  if (run.config.workdir) subs.push([run.config.workdir, "<workdir>"]);
  subs.push([path.join(DATA_DIR, "bench", "snapshots"), "<snapshots>"]);
  subs.push([DATA_DIR, "<data>"]);
  subs.push([os.homedir(), "<home>"]);
  subs.sort((a, b) => b[0].length - a[0].length); // longest prefix first

  let json = JSON.stringify(clone);
  for (const [from, to] of subs) if (from) json = json.split(from).join(to);
  const sanitized: BenchRun = JSON.parse(json);
  if (sanitized.config.workdir) sanitized.config.workdir = "<workdir>";
  return sanitized;
}

function bestLabel(run: BenchRun): string {
  const bestRow = run.summary?.[0];
  if (!bestRow) return "no result";
  const result = run.results[bestRow.resultIndex];
  const label = result ? contenderLabel(result.spec) : `#${bestRow.resultIndex}`;
  const pct = bestRow.scoreSource === "checklist" || bestRow.scoreSource === "verifier";
  const score = pct ? `${bestRow.composite.toFixed(0)}%` : bestRow.composite.toFixed(1);
  return `${label} ${score}`;
}

function buildPublishMarkdown(run: BenchRun): string {
  const L: string[] = [];
  const title = run.config.taskTitle || run.config.prompt.slice(0, 80);
  L.push(`# Benchmark — ${title}`, "");
  L.push(`- Run \`${run.id.slice(0, 8)}\` · ${new Date(run.createdAt).toISOString()} · status: ${run.status}`);
  if (run.config.execute) {
    L.push(`- Scoring: execution verifier (pass@1) · ${run.config.reps} rep(s)`);
  } else {
    const judges = run.config.judges ?? (run.config.judge ? [run.config.judge] : []);
    L.push(`- Scoring: ${run.config.judgePasses} judge pass(es) · ${run.config.reps} rep(s)`);
    L.push(`- Judges: ${judges.map((j) => `${j.provider}/${j.model}`).join(", ") || "—"}`);
  }
  if (run.extendedFrom) L.push(`- Extended from \`${run.extendedFrom.slice(0, 8)}\``);
  L.push("", "## Ranking", "");
  L.push("| Rank | Contender | Score | Notes |", "|---|---|---|---|");
  (run.summary ?? []).forEach((row, i) => {
    const result = run.results[row.resultIndex];
    const label = result ? contenderLabel(result.spec) : `#${row.resultIndex}`;
    const pct = row.scoreSource === "checklist" || row.scoreSource === "verifier";
    const score = pct ? `${row.composite.toFixed(1)}%` : `${row.composite.toFixed(1)} ± ${row.spread.toFixed(1)}`;
    const notes = row.scoreSource === "verifier" ? (row.resolved ? "resolved ✓" : "unresolved ✗") : (row.scoreSource ?? "");
    L.push(`| ${i + 1}${i === 0 ? " 🥇" : ""} | ${label}${result?.extension ? " (added)" : ""} | ${score} | ${notes} |`);
  });
  L.push("");
  return L.join("\n");
}

interface IndexEntry {
  id: string;
  taskId?: string;
  date: string;
  contenders: string[];
  best?: string;
  path: string;
}

async function updateIndex(repo: string, run: BenchRun, jsonRel: string, date: string): Promise<string> {
  const indexRel = path.join("bench", "results", "index.json");
  const indexAbs = path.join(repo, indexRel);
  let entries: IndexEntry[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(indexAbs, "utf8"));
    if (Array.isArray(parsed)) entries = parsed;
    else if (Array.isArray(parsed?.runs)) entries = parsed.runs;
  } catch {
    /* new index */
  }
  const entry: IndexEntry = {
    id: run.id,
    taskId: run.config.taskId,
    date,
    contenders: [...new Set(run.results.map((r) => contenderLabel(r.spec)))],
    best: bestLabel(run),
    path: jsonRel.split(path.sep).join("/"),
  };
  entries = entries.filter((e) => e.id !== run.id);
  entries.push(entry);
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  await fs.writeFile(indexAbs, JSON.stringify(entries, null, 2), "utf8");
  return indexRel;
}

async function hasStagedChanges(repo: string, paths: string[]): Promise<boolean> {
  try {
    await git(["-C", repo, "diff", "--cached", "--quiet", "--", ...paths]);
    return false; // exit 0 → nothing staged
  } catch {
    return true; // exit 1 → staged changes exist
  }
}

export interface PublishResult {
  state: BenchPublishState;
  pushError?: string; // set when the commit landed locally but the push failed
}

// Write + commit (+ push) a finished run into the results repo. Only the three
// result paths are staged, so a dirty tree elsewhere is untouched. Re-publishing
// an unchanged run is a no-op that returns the existing commit (idempotent).
export async function publishBenchRun(run: BenchRun): Promise<PublishResult> {
  if (run.status === "running" || run.status === "judging") {
    throw new Error("Cannot publish a running benchmark");
  }
  const repo = await resolveBenchResultsRepo();
  if (!repo) {
    throw new Error("No benchmark results repo is configured. Set your local Fuse clone in Settings → Benchmarks.");
  }

  const sanitized = sanitizeRun(run);
  const taskSeg = safeSeg(run.config.taskId || "custom");
  const date = new Date(run.createdAt).toISOString().slice(0, 10);
  const runId8 = run.id.slice(0, 8);
  const dirRel = path.join("bench", "results", taskSeg);
  const jsonRel = path.join(dirRel, `${date}-${runId8}.json`);
  const mdRel = path.join(dirRel, `${date}-${runId8}.md`);

  await fs.mkdir(path.join(repo, dirRel), { recursive: true });
  await fs.writeFile(path.join(repo, jsonRel), JSON.stringify(sanitized, null, 2), "utf8");
  await fs.writeFile(path.join(repo, mdRel), buildPublishMarkdown(sanitized), "utf8");
  const indexRel = await updateIndex(repo, sanitized, jsonRel, date);

  const staged = [jsonRel, mdRel, indexRel];
  await git(["-C", repo, "add", ...staged]);

  const commitMsg = `bench: ${run.config.taskTitle || taskSeg} — ${bestLabel(run)} (${runId8})`;
  if (await hasStagedChanges(repo, staged)) {
    await git(["-C", repo, "commit", "-m", commitMsg]);
  }
  const commit = (await git(["-C", repo, "rev-parse", "HEAD"])).trim();

  let pushError: string | undefined;
  try {
    await git(["-C", repo, "push"]);
  } catch (e: any) {
    pushError = (e?.message ?? String(e)).trim().split("\n").slice(-3).join(" ").slice(0, 300);
  }

  const state: BenchPublishState = {
    at: run.published?.at ?? stableUpdatedAt(run),
    commit,
    path: jsonRel.split(path.sep).join("/"),
    pushed: !pushError,
  };
  run.published = state;
  run.publishError = pushError;
  return { state, pushError };
}

// Best-effort auto-publish after a run finishes. Never throws; failures are
// recorded on the run (publishError) and surfaced in the UI without affecting
// the run itself. Silently skips when auto-publish is off or no repo resolves.
export async function autoPublishBenchRun(run: BenchRun): Promise<void> {
  try {
    const cfg = await readSettings();
    if (!cfg.benchAutoPublish) return;
    const repo = await resolveBenchResultsRepo(cfg);
    if (!repo) return;
    await publishBenchRun(run);
  } catch (e: any) {
    run.publishError = e?.message ?? String(e);
  }
}

// Read every published run out of the results repo (for the shared History
// merge). Each is tagged `shared: true`; malformed files are skipped.
export async function readSharedRuns(): Promise<BenchRun[]> {
  const repo = await resolveBenchResultsRepo();
  if (!repo) return [];
  const base = path.join(repo, "bench", "results");
  if (!(await pathExists(base))) return [];
  const taskDirs = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  const out: BenchRun[] = [];
  for (const dir of taskDirs) {
    if (!dir.isDirectory()) continue;
    const files = await fs.readdir(path.join(base, dir.name)).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const run = JSON.parse(await fs.readFile(path.join(base, dir.name, file), "utf8")) as BenchRun;
        if (run && typeof run.id === "string" && Array.isArray(run.results)) {
          run.shared = true;
          out.push(run);
        }
      } catch {
        /* skip malformed */
      }
    }
  }
  return out;
}

export async function readSharedRun(id: string): Promise<BenchRun | null> {
  const runs = await readSharedRuns();
  return runs.find((run) => run.id === id) ?? null;
}
