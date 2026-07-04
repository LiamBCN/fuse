import { promises as fs } from "fs";
import path from "path";
import { DATA_DIR } from "./db";
import { ALL_BUILTIN_TASKS, DEFAULT_TASKS, type BenchTask, type ChecklistAxis, type ChecklistItem } from "./bench-tasks";

const DIR = path.join(DATA_DIR, "bench", "tasks");
const VALID_AXES = new Set<ChecklistAxis>(["grounding", "coverage", "actionability", "testing", "scope"]);

async function ensure() {
  await fs.mkdir(DIR, { recursive: true });
}

export function safeBenchTaskId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function fileFor(id: string): string {
  if (!safeBenchTaskId(id)) throw new Error("Invalid benchmark task id");
  return path.join(DIR, `${id}.json`);
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "custom-task"
  );
}

function normalizeChecklist(input: any): ChecklistItem[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item, i) => {
      const text = typeof item?.text === "string" ? item.text.trim() : "";
      if (!text) return null;
      const axis = VALID_AXES.has(item?.axis) ? item.axis : "coverage";
      const points = Number(item?.points);
      return {
        id: typeof item?.id === "string" && item.id.trim() ? item.id.trim() : `custom-${i + 1}`,
        text,
        points: Number.isFinite(points) ? Math.max(-10, Math.min(10, points)) : 1,
        axis,
      } satisfies ChecklistItem;
    })
    .filter((item): item is ChecklistItem => !!item);
}

function normalizeTask(input: any, existingId?: string): BenchTask {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
  if (!title) throw new Error("Task title required");
  if (!prompt) throw new Error("Task prompt required");
  const id = existingId || (typeof input?.id === "string" && input.id.trim() ? input.id.trim() : `custom-${slug(title)}`);
  if (!safeBenchTaskId(id)) throw new Error("Task id may contain only letters, numbers, underscores, and dashes");
  if (ALL_BUILTIN_TASKS.some((task) => task.id === id)) throw new Error("Built-in tasks cannot be overwritten");

  const repos = Array.isArray(input?.repos)
    ? input.repos
        .map((repo: any) => {
          const sourcePath = typeof repo?.sourcePath === "string" ? repo.sourcePath.trim() : "";
          const gitUrl = typeof repo?.gitUrl === "string" ? repo.gitUrl.trim() : "";
          const dirName = typeof repo?.dirName === "string" ? repo.dirName.trim() : "";
          return {
            ...(sourcePath ? { sourcePath } : {}),
            ...(gitUrl ? { gitUrl } : {}),
            ...(dirName ? { dirName } : {}),
            pinnedCommit: typeof repo?.pinnedCommit === "string" ? repo.pinnedCommit.trim() : "",
            stripGlobs: Array.isArray(repo?.stripGlobs)
              ? repo.stripGlobs.filter((glob: any) => typeof glob === "string" && glob.trim()).map((glob: string) => glob.trim())
              : [],
          };
        })
        .filter((repo: any) => (repo.sourcePath || repo.gitUrl) && repo.pinnedCommit)
    : [];

  return {
    id,
    title,
    summary:
      typeof input?.summary === "string" && input.summary.trim()
        ? input.summary.trim()
        : prompt.replace(/\s+/g, " ").slice(0, 140),
    prompt,
    repos,
    checklist: normalizeChecklist(input?.checklist),
    tags: Array.isArray(input?.tags)
      ? input.tags.filter((tag: any) => typeof tag === "string" && tag.trim()).map((tag: string) => tag.trim())
      : ["custom"],
    builtIn: false,
  };
}

async function readCustomTask(id: string): Promise<BenchTask | null> {
  if (!safeBenchTaskId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(fileFor(id), "utf8")) as BenchTask;
  } catch {
    return null;
  }
}

export async function listBenchTasks(): Promise<BenchTask[]> {
  await ensure();
  const entries = await fs.readdir(DIR).catch(() => []);
  const custom = await Promise.all(
    entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => readCustomTask(path.basename(name, ".json"))),
  );
  return [
    ...DEFAULT_TASKS,
    ...custom.filter((task): task is BenchTask => !!task).sort((a, b) => a.title.localeCompare(b.title)),
  ];
}

export async function readBenchTask(id: string): Promise<BenchTask | null> {
  // Resolve any built-in (visible or parked) so old runs referencing a demoted
  // task still open, extend, and publish; the picker still only lists DEFAULT_TASKS.
  const builtIn = ALL_BUILTIN_TASKS.find((task) => task.id === id);
  if (builtIn) return builtIn;
  await ensure();
  return readCustomTask(id);
}

export async function createBenchTask(input: any): Promise<BenchTask> {
  await ensure();
  const task = normalizeTask(input);
  try {
    await fs.access(fileFor(task.id));
    throw new Error("A custom task with this id already exists");
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  await fs.writeFile(fileFor(task.id), JSON.stringify(task, null, 2), "utf8");
  return task;
}

export async function updateBenchTask(id: string, input: any): Promise<BenchTask> {
  await ensure();
  if (ALL_BUILTIN_TASKS.some((task) => task.id === id)) throw new Error("Built-in tasks cannot be edited");
  const task = normalizeTask({ ...input, id }, id);
  await fs.writeFile(fileFor(id), JSON.stringify(task, null, 2), "utf8");
  return task;
}

export async function deleteBenchTask(id: string): Promise<void> {
  if (ALL_BUILTIN_TASKS.some((task) => task.id === id)) throw new Error("Built-in tasks cannot be deleted");
  if (!safeBenchTaskId(id)) return;
  try {
    await fs.unlink(fileFor(id));
  } catch {
    /* already gone */
  }
}
