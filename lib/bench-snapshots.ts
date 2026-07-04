import { promises as fs } from "fs";
import path from "path";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { DATA_DIR } from "./db";
import { DEFAULT_STRIP_GLOBS, type BenchTask, type BenchTaskRepo } from "./bench-tasks";

const execFile = promisify(execFileCb);
const SNAPSHOTS_DIR = path.join(DATA_DIR, "bench", "snapshots");
const MANIFEST = "snapshot.json";

interface SnapshotRepoManifest {
  sourcePath: string;
  path: string;
  pinnedCommit: string;
  commit: string;
}

interface SnapshotManifest {
  taskId: string;
  path: string;
  createdAt: string;
  repos: SnapshotRepoManifest[];
}

export interface SnapshotStatus {
  ready: boolean;
  path: string;
  commit?: string;
  repos: SnapshotRepoManifest[];
  error?: string;
}

export interface WorkdirCheck {
  path: string;
  exists: boolean;
  isGitRepo: boolean;
  dirty: boolean;
  litter: string[];
  warning?: string;
}

async function git(args: string[], cwd?: string, env?: Partial<NodeJS.ProcessEnv>) {
  const { stdout, stderr } = await execFile("git", args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 10 * 1024 * 1024,
  });
  return `${stdout}${stderr}`;
}

async function ensureRoot() {
  await fs.mkdir(SNAPSHOTS_DIR, { recursive: true });
}

function assertSnapshotPath(p: string) {
  const rel = path.relative(SNAPSHOTS_DIR, p);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to mutate path outside benchmark snapshots: ${p}`);
  }
}

function snapshotDir(task: BenchTask): string {
  return path.join(SNAPSHOTS_DIR, task.id);
}

// Stable snapshot folder name for a repo: explicit `dirName`, else the basename
// of its local path or git URL (with a trailing `.git` stripped). URL-cloned
// repos need this so their folder name doesn't depend on a local checkout path.
function repoBaseName(repo: BenchTaskRepo): string {
  if (repo.dirName) return repo.dirName;
  const source = (repo.sourcePath ?? repo.gitUrl ?? "").replace(/\.git$/, "");
  return path.basename(source) || "repo";
}

function repoDir(task: BenchTask, repo: BenchTaskRepo, index: number): string {
  const base = repoBaseName(repo) || `repo-${index + 1}`;
  const duplicate = task.repos.findIndex((candidate) => repoBaseName(candidate) === base);
  return path.join(snapshotDir(task), duplicate === index ? base : `${base}-${index + 1}`);
}

function manifestFile(task: BenchTask): string {
  return path.join(snapshotDir(task), MANIFEST);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globRegex(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map(escapeRegex)
    .join("[^/]*")
    .replace(/\\\?/, ".");
  return new RegExp(`^${escaped}$`);
}

function matchesGlob(rel: string, glob: string): boolean {
  const normalized = rel.split(path.sep).join("/");
  const target = glob.includes("/") ? normalized : path.basename(normalized);
  return globRegex(glob).test(target);
}

async function listGitFiles(repoPath: string): Promise<string[]> {
  const out = await git(["-C", repoPath, "ls-files", "-z", "-co", "--exclude-standard"]);
  return out.split("\0").filter(Boolean);
}

async function stripLitter(repoPath: string, globs: string[]) {
  if (!globs.length) return;
  const files = await listGitFiles(repoPath);
  const matches = files.filter((file) => globs.some((glob) => matchesGlob(file, glob)));
  await Promise.all(matches.map((file) => fs.rm(path.join(repoPath, file), { force: true, recursive: true })));
}

async function createSnapshotRepo(task: BenchTask, repo: BenchTaskRepo, index: number): Promise<SnapshotRepoManifest> {
  const target = repoDir(task, repo, index);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await cloneRepo(task, repo, target);
  await stripLitter(target, repo.stripGlobs ?? []);

  const status = await git(["-C", target, "status", "--porcelain"]);
  if (status.trim()) {
    await git(["-C", target, "add", "-A"]);
    await git(
      [
        "-C",
        target,
        "-c",
        "user.name=Fuse Bench",
        "-c",
        "user.email=fuse-bench@example.invalid",
        "commit",
        "-m",
        `Strip benchmark litter for ${task.id}`,
      ],
      undefined,
      {
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    );
  }

  const commit = (await git(["-C", target, "rev-parse", "HEAD"])).trim();
  return { sourcePath: repo.sourcePath ?? repo.gitUrl ?? "", path: target, pinnedCommit: repo.pinnedCommit, commit };
}

// Resolution order: a local `sourcePath` that exists wins (fast, offline
// `clone --local` — the Liam-local + private-repo path). Otherwise fall back to
// `gitUrl` with a blobless clone that stays small but can still materialize the
// pinned tree on detach. Neither available → a typed error naming what's missing.
async function cloneRepo(task: BenchTask, repo: BenchTaskRepo, target: string): Promise<void> {
  const hasLocal = !!repo.sourcePath && (await pathExists(repo.sourcePath));
  if (hasLocal) {
    await git(["clone", "--local", repo.sourcePath!, target]);
    await detachTo(repo, target);
    return;
  }
  if (repo.gitUrl) {
    try {
      await git(["clone", "--filter=blob:none", "--no-checkout", repo.gitUrl, target]);
      await detachTo(repo, target);
    } catch (e: any) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `Failed to clone ${repo.gitUrl} at ${repo.pinnedCommit.slice(0, 12)} for task ${task.id}: ${e?.message ?? String(e)}. ` +
          `Ensure the pinned commit is pushed to the remote (git branch -r --contains ${repo.pinnedCommit.slice(0, 12)}).`,
      );
    }
    return;
  }
  const missing = repo.sourcePath
    ? `local checkout ${repo.sourcePath} does not exist and no gitUrl fallback is configured`
    : "no sourcePath or gitUrl is configured";
  throw new Error(
    `Cannot prepare a snapshot for task ${task.id}: ${missing}. ` +
      `Migma tasks require local access to the Migma repos; only the Fuse task can be cloned anywhere.`,
  );
}

async function detachTo(repo: BenchTaskRepo, target: string): Promise<void> {
  await git(["-C", target, "checkout", "--detach", repo.pinnedCommit]);
}

async function readManifest(task: BenchTask): Promise<SnapshotManifest | null> {
  try {
    return JSON.parse(await fs.readFile(manifestFile(task), "utf8")) as SnapshotManifest;
  } catch {
    return null;
  }
}

async function validateManifest(task: BenchTask, manifest: SnapshotManifest): Promise<SnapshotManifest> {
  if (manifest.taskId !== task.id) throw new Error(`Snapshot manifest task mismatch for ${task.id}`);
  if (manifest.repos.length !== task.repos.length) throw new Error(`Snapshot repo count mismatch for ${task.id}`);
  assertSnapshotPath(manifest.path);
  for (const repo of manifest.repos) {
    assertSnapshotPath(repo.path);
    const head = (await git(["-C", repo.path, "rev-parse", "HEAD"])).trim();
    if (head !== repo.commit) throw new Error(`Snapshot ${task.id} repo ${repo.path} is at ${head}, expected ${repo.commit}`);
  }
  return manifest;
}

export async function ensureSnapshot(task: BenchTask): Promise<SnapshotStatus> {
  await ensureRoot();
  const dir = snapshotDir(task);
  assertSnapshotPath(dir);
  const existing = await readManifest(task);
  if (existing) {
    const manifest = await validateManifest(task, existing);
    return {
      ready: true,
      path: manifest.path,
      commit: manifest.repos.map((repo) => repo.commit.slice(0, 12)).join(", "),
      repos: manifest.repos,
    };
  }

  if (await pathExists(dir)) {
    const entries = await fs.readdir(dir).catch(() => []);
    if (entries.length) throw new Error(`Snapshot directory exists without a manifest: ${dir}`);
  }

  await fs.mkdir(dir, { recursive: true });
  const repos: SnapshotRepoManifest[] = [];
  for (let i = 0; i < task.repos.length; i++) {
    repos.push(await createSnapshotRepo(task, task.repos[i], i));
  }
  const manifest: SnapshotManifest = {
    taskId: task.id,
    path: dir,
    createdAt: new Date().toISOString(),
    repos,
  };
  await fs.writeFile(manifestFile(task), JSON.stringify(manifest, null, 2), "utf8");
  return {
    ready: true,
    path: dir,
    commit: repos.map((repo) => repo.commit.slice(0, 12)).join(", "),
    repos,
  };
}

export async function getSnapshotStatus(task: BenchTask): Promise<SnapshotStatus> {
  const dir = snapshotDir(task);
  const manifest = await readManifest(task);
  if (!manifest) return { ready: false, path: dir, repos: [] };
  try {
    const valid = await validateManifest(task, manifest);
    return {
      ready: true,
      path: valid.path,
      commit: valid.repos.map((repo) => repo.commit.slice(0, 12)).join(", "),
      repos: valid.repos,
    };
  } catch (e: any) {
    return { ready: false, path: dir, repos: manifest.repos ?? [], error: e?.message ?? String(e) };
  }
}

export async function snapshotWorkdir(task: BenchTask): Promise<string | undefined> {
  if (!task.repos.length) return undefined;
  const status = await ensureSnapshot(task);
  return status.path;
}

export async function resetSnapshot(task: BenchTask): Promise<void> {
  if (!task.repos.length) return;
  const status = await ensureSnapshot(task);
  assertSnapshotPath(status.path);
  for (const repo of status.repos) {
    assertSnapshotPath(repo.path);
    await git(["-C", repo.path, "checkout", "--", "."]);
    await git(["-C", repo.path, "clean", "-fd"]);
  }
}

async function gitRoot(p: string): Promise<string | null> {
  try {
    return (await git(["-C", p, "rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
}

async function immediateGitRepos(p: string): Promise<string[]> {
  const root = await gitRoot(p);
  if (root) return [root];
  const entries = await fs.readdir(p, { withFileTypes: true }).catch(() => []);
  const repos: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(p, entry.name);
    if (await pathExists(path.join(child, ".git"))) repos.push(child);
  }
  return repos;
}

async function findLitter(p: string, limit = 30): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number) {
    if (out.length >= limit || depth > 3) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".next") continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(p, abs) || entry.name;
      if (DEFAULT_STRIP_GLOBS.some((glob) => matchesGlob(rel, glob))) out.push(rel);
      if (entry.isDirectory()) await walk(abs, depth + 1);
    }
  }
  await walk(p, 0);
  return out;
}

export async function checkWorkdir(workdir: string): Promise<WorkdirCheck> {
  const resolved = path.resolve(workdir);
  const exists = await pathExists(resolved);
  if (!exists) return { path: resolved, exists: false, isGitRepo: false, dirty: false, litter: [], warning: "Folder does not exist." };

  const repos = await immediateGitRepos(resolved);
  const dirtyStatuses = await Promise.all(
    repos.map(async (repo) => ({
      repo,
      status: (await git(["-C", repo, "status", "--short"]).catch(() => "")).trim(),
    })),
  );
  const dirty = dirtyStatuses.some((item) => item.status.length > 0);
  const litter = await findLitter(resolved);
  const warnings: string[] = [];
  if (!repos.length) warnings.push("not a git repo");
  if (dirty) warnings.push("has uncommitted changes");
  if (litter.length) warnings.push("contains benchmark/plan litter");
  return {
    path: resolved,
    exists: true,
    isGitRepo: repos.length > 0,
    dirty,
    litter,
    warning: warnings.length ? `Not reproducible: ${warnings.join(", ")}.` : undefined,
  };
}
