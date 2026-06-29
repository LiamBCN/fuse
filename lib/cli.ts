// Run answers through locally-installed CLIs (Claude Code, Codex) instead of
// metered provider APIs. These use the user's existing subscription logins
// (~/.claude, ~/.codex), so there's no per-token API cost and no API key.
//
// Server-only (spawns child processes). Never import from client code.
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { accessSync, constants, existsSync } from "fs";
import os from "os";
import path from "path";
import type { CallResult, ChatMessage } from "./providers";

const HOME = os.homedir();

// A neutral working directory so the CLIs don't pick up project files as context.
const WORKDIR = path.join(os.tmpdir(), "fuse-cli");

// Extra bin dirs to look in (and to expose on the child's PATH). A GUI-launched
// app inherits almost nothing, so we can't rely on the shell PATH.
const EXTRA_DIRS = [
  path.join(HOME, ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(HOME, ".bun/bin"),
  path.join(HOME, ".cargo/bin"),
  "/usr/bin",
  "/bin",
];

const CLAUDE_CANDIDATES = [
  process.env.FUSE_CLAUDE_BIN,
  path.join(HOME, ".local/bin/claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

const CODEX_CANDIDATES = [
  process.env.FUSE_CODEX_BIN,
  "/Applications/Codex.app/Contents/Resources/codex",
  path.join(HOME, ".codex/plugins/.plugin-appserver/codex"),
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
];

function resolveBin(name: string, candidates: (string | undefined)[]): string | null {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  // Fall back to scanning PATH + the extra dirs.
  const dirs = [...(process.env.PATH || "").split(":"), ...EXTRA_DIRS];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const childEnv = () => ({
  ...process.env,
  HOME,
  PATH: [...EXTRA_DIRS, process.env.PATH || ""].join(":"),
});

// Flatten the conversation into a single prompt (+ optional system text). The
// CLIs are single-shot, so multi-turn history is rendered as a transcript.
// Images aren't supported over the CLIs and are dropped.
function render(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const convo = messages.filter((m) => m.role !== "system");
  let prompt: string;
  if (convo.length === 1 && convo[0].role === "user") {
    prompt = convo[0].content;
  } else {
    prompt =
      convo.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n") +
      "\n\nAssistant:";
  }
  return { system, prompt };
}

const TIMEOUT_MS = 180_000;

// Spawn a process, optionally feed stdin, and collect stdout/stderr.
function run(
  bin: string,
  args: string[],
  stdin: string | null,
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: childEnv() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `exited with code ${code}`));
    });

    if (stdin != null) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

const estTokens = (s: string) => Math.ceil((s?.length ?? 0) / 4);

// Use the configured folder if it exists; otherwise a neutral temp dir.
async function pickCwd(workdir?: string): Promise<{ cwd: string; scoped: boolean }> {
  if (workdir && existsSync(workdir)) return { cwd: workdir, scoped: true };
  await fs.mkdir(WORKDIR, { recursive: true });
  return { cwd: WORKDIR, scoped: false };
}

async function runClaude(model: string, messages: ChatMessage[], workdir?: string): Promise<CallResult> {
  const bin = resolveBin("claude", CLAUDE_CANDIDATES);
  if (!bin) throw new Error("Claude CLI not found. Install it or set FUSE_CLAUDE_BIN.");
  const { system, prompt } = render(messages);
  const { cwd, scoped } = await pickCwd(workdir);

  const args = ["-p", "--output-format", "json", "--model", model || "sonnet"];
  if (system) args.push("--append-system-prompt", system);
  if (scoped) {
    // Full access to the folder — all tools, edits, and shell — like running
    // `claude` in that directory and approving everything.
    args.push("--max-turns", "60", "--permission-mode", "bypassPermissions");
  } else {
    args.push("--max-turns", "1");
  }

  const { stdout } = await run(bin, args, prompt, cwd);
  let data: any;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`Unexpected claude output: ${stdout.slice(0, 200)}`);
  }
  if (data.is_error) throw new Error(data.result || "claude CLI error");

  const u = data.usage ?? {};
  const prompt_tokens =
    (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const completion_tokens = u.output_tokens ?? 0;
  return {
    content: data.result ?? "",
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
  };
}

let codexSeq = 0;

async function runCodex(model: string, messages: ChatMessage[], workdir?: string): Promise<CallResult> {
  const bin = resolveBin("codex", CODEX_CANDIDATES);
  if (!bin) throw new Error("Codex CLI not found. Install it or set FUSE_CODEX_BIN.");
  const { system, prompt } = render(messages);
  const { cwd, scoped } = await pickCwd(workdir);

  const full = system ? `${system}\n\n${prompt}` : prompt;
  // Keep the output file out of the (possibly user-owned) folder.
  await fs.mkdir(WORKDIR, { recursive: true });
  const outFile = path.join(WORKDIR, `codex-${Date.now()}-${codexSeq++}.txt`);
  // With a folder: full workspace access (read/edit/run within it). Without:
  // read-only in a neutral dir (plain chat).
  const sandbox = scoped ? "workspace-write" : "read-only";
  const args = ["exec", "--skip-git-repo-check", "--sandbox", sandbox, "-C", cwd, "-o", outFile];
  if (model && model !== "default") args.push("-m", model);
  args.push(full);

  try {
    await run(bin, args, null, cwd);
    const content = (await fs.readFile(outFile, "utf8")).trim();
    return {
      content,
      usage: {
        prompt_tokens: estTokens(full),
        completion_tokens: estTokens(content),
        total_tokens: estTokens(full) + estTokens(content),
      },
    };
  } finally {
    fs.unlink(outFile).catch(() => {});
  }
}

export async function runCli(
  provider: "claude-cli" | "codex-cli",
  model: string,
  messages: ChatMessage[],
  workdir?: string,
): Promise<CallResult> {
  return provider === "claude-cli"
    ? runClaude(model, messages, workdir)
    : runCodex(model, messages, workdir);
}
