// Deterministic, judge-free scoring for execution benchmarks. After a contender
// implements a task, we score the *code it actually produced* — not a plan's
// prose — with structural checks over its git diff plus optional shell commands.
// This mirrors how OpenAI/Google score SWE-bench and Terminal-Bench (pass@1,
// all-or-nothing on the hard checks), but stays cheap: diff/grep steps need no
// dependencies and run in milliseconds.
//
// Server-only (spawns child processes). Never import from client code.
import { promises as fs } from "fs";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import { execFile as execFileCb, spawn } from "child_process";
import { promisify } from "util";
import { ensureSnapshot } from "./bench-snapshots";
import type { BenchTask } from "./bench-tasks";
import type { BenchVerifier, VerifierResult, VerifierStep, VerifierStepResult } from "./bench-types";

const execFile = promisify(execFileCb);

// A GUI-launched app inherits almost no PATH, so expose the usual bin dirs to
// verifier commands (npm/npx/node/git), same approach as lib/cli.ts.
const HOME = os.homedir();
const EXTRA_DIRS = [
  path.join(HOME, ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(HOME, ".bun/bin"),
  path.join(HOME, ".cargo/bin"),
  "/usr/bin",
  "/bin",
];
const childPath = [...EXTRA_DIRS, process.env.PATH || ""].join(":");
const childEnv = () => ({ ...process.env, HOME, PATH: childPath });

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out", ".cache", "coverage",
  ".turbo", ".venv", "venv", "__pycache__", ".idea", ".vscode",
]);

interface RepoRef {
  name: string; // basename, used to match a step's `repo`
  path: string; // absolute path to the repo working tree
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await execFile("git", args, { cwd, env: childEnv(), maxBuffer: 32 * 1024 * 1024 });
  return `${stdout}${stderr}`;
}

function makeRegex(pattern: string, flags?: string): RegExp {
  // Default case-insensitive; callers can pass explicit flags (e.g. "" for
  // case-sensitive, "im" for multiline). Never allow the global flag to leak
  // in and make `.test()` stateful.
  const f = (flags ?? "i").replace(/g/g, "");
  return new RegExp(pattern, f);
}

// Concatenate the ADDED lines (`+` but not the `+++` file header) of a repo's
// working diff. `git add -A -N` marks new files as intent-to-add so their
// contents show up as additions; we clear that marker afterwards so the diff is
// side-effect-free for the snapshot-reset that follows.
async function addedLines(repo: RepoRef): Promise<string> {
  try {
    await git(["add", "-A", "-N", "."], repo.path);
    const diff = await git(["diff", "--unified=0", "--no-color"], repo.path);
    await git(["reset", "-q"], repo.path).catch(() => {});
    return diff
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
      .join("\n");
  } catch {
    return "";
  }
}

async function diffStatFor(repos: RepoRef[]): Promise<string> {
  const parts: string[] = [];
  for (const repo of repos) {
    try {
      await git(["add", "-A", "-N", "."], repo.path);
      const stat = (await git(["diff", "--stat", "--no-color"], repo.path)).trim();
      await git(["reset", "-q"], repo.path).catch(() => {});
      if (stat) parts.push(repos.length > 1 ? `# ${repo.name}\n${stat}` : stat);
    } catch {
      /* ignore per-repo diff failures */
    }
  }
  return parts.join("\n\n");
}

function reposForStep(repos: RepoRef[], repoName?: string): RepoRef[] {
  if (!repoName) return repos;
  const match = repos.filter((r) => r.name === repoName);
  return match.length ? match : repos;
}

async function walkFiles(root: string, cap = 4000): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    if (out.length >= cap) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= cap) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.push(abs);
    }
  }
  await walk(root);
  return out;
}

// Read a file or every file under a directory and test the regex against the
// combined text. Returns whether the pattern was found.
async function grepPath(target: string, re: RegExp): Promise<boolean> {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return false;
  }
  const files = stat.isDirectory() ? await walkFiles(target) : [target];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    if (text && re.test(text)) return true;
  }
  return false;
}

// Run a shell command; pass iff it exits 0. Killed after `timeoutMs` of no exit.
function runCommand(cmd: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { cwd, env: childEnv() });
    let out = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve({ ok: false, detail: `timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = out.trim().split("\n").slice(-4).join(" ").slice(-300);
      resolve({ ok: code === 0, detail: `exit ${code ?? "?"}${tail ? ` · ${tail}` : ""}` });
    });
  });
}

async function runStep(
  step: VerifierStep,
  repos: RepoRef[],
  workdir: string,
  addedByRepo: Map<string, string>,
  timeoutMs: number,
): Promise<VerifierStepResult> {
  const soft = !!step.soft;
  const base: Pick<VerifierStepResult, "label" | "kind" | "soft"> = { label: step.label, kind: step.kind, soft };
  try {
    if (step.kind === "run") {
      const cwd = path.resolve(workdir, step.cwd ?? ".");
      const { ok, detail } = await runCommand(step.cmd, cwd, timeoutMs);
      return { ...base, passed: ok, detail };
    }
    if (step.kind === "diff") {
      const want = step.want ?? true;
      const re = makeRegex(step.pattern, step.flags);
      const targets = reposForStep(repos, step.repo);
      const text = targets.map((r) => addedByRepo.get(r.name) ?? "").join("\n");
      const found = re.test(text);
      return { ...base, passed: found === want, detail: found ? "pattern present in additions" : "pattern absent from additions" };
    }
    // grep
    const want = step.want ?? true;
    const re = makeRegex(step.pattern, step.flags);
    const found = await grepPath(path.resolve(workdir, step.path), re);
    return { ...base, passed: found === want, detail: found ? "pattern present" : "pattern absent" };
  } catch (e: any) {
    return { ...base, passed: false, detail: e?.message ?? String(e) };
  }
}

// Resolve the repos to inspect: snapshot repos for a pinned task, otherwise the
// custom workdir treated as a single repo.
async function resolveRepos(task: BenchTask | undefined, workdir: string): Promise<RepoRef[]> {
  if (task?.repos.length) {
    const status = await ensureSnapshot(task);
    return status.repos.map((r) => ({ name: path.basename(r.path), path: r.path }));
  }
  return existsSync(path.join(workdir, ".git")) ? [{ name: path.basename(workdir), path: workdir }] : [];
}

export async function runVerifier(
  verifier: BenchVerifier,
  workdir: string,
  task?: BenchTask,
): Promise<VerifierResult> {
  const empty = (error: string): VerifierResult => ({
    resolved: false,
    passedSteps: 0,
    totalSteps: verifier.steps.length,
    hardTotal: verifier.steps.filter((s) => !s.soft).length,
    hardPassed: 0,
    steps: [],
    error,
  });

  const repos = await resolveRepos(task, workdir);
  if (!repos.length) return empty("No git repo to verify against.");

  const timeoutMs = verifier.timeoutMs && verifier.timeoutMs > 0 ? verifier.timeoutMs : 120_000;

  // Compute added lines once per repo (diff steps reuse it), plus the diffstat.
  const addedByRepo = new Map<string, string>();
  for (const repo of repos) addedByRepo.set(repo.name, await addedLines(repo));
  const diffStat = await diffStatFor(repos);

  const steps: VerifierStepResult[] = [];
  for (const step of verifier.steps) {
    steps.push(await runStep(step, repos, workdir, addedByRepo, timeoutMs));
  }

  const hard = steps.filter((s) => !s.soft);
  const hardPassed = hard.filter((s) => s.passed).length;
  return {
    resolved: hard.length > 0 && hardPassed === hard.length,
    passedSteps: steps.filter((s) => s.passed).length,
    totalSteps: steps.length,
    hardTotal: hard.length,
    hardPassed,
    steps,
    diffStat: diffStat || undefined,
  };
}
