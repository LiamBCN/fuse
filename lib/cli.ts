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
import type { ActivityFn, CallResult, ChatMessage } from "./providers";

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
  // Isolate the spawned CLI from the user's global Claude config so their
  // plugins/hooks/skills (superpowers, output styles, SessionStart hooks, etc.)
  // don't load into Fuse's proposer/aggregator runs. Those hooks push the model
  // toward tool use and skill invocation, which wastes the turn budget on a
  // step that should just emit text. A dedicated empty config dir keeps runs
  // deterministic.
  CLAUDE_CONFIG_DIR: path.join(WORKDIR, "claude-config"),
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

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

// We deliberately do NOT cap total runtime tightly. A real plan can reason and
// research for many minutes - sometimes far longer - and killing it mid-thought
// is the bug we're fixing. Instead we watch for *silence*: a healthy CLI streams
// output the whole time it works, so if nothing at all has been emitted for
// IDLE_TIMEOUT_MS the process is almost certainly wedged and we kill it then -
// not while it's still making progress. A generous absolute backstop guards
// against a truly runaway process. Both are env-tunable.
const IDLE_TIMEOUT_MS = num(process.env.FUSE_CLI_IDLE_TIMEOUT_MS, 300_000); // 5 min of total silence
const MAX_TIMEOUT_MS = num(process.env.FUSE_CLI_MAX_TIMEOUT_MS, 3_600_000); // 60 min hard backstop

interface RunOpts {
  // Called with every raw stdout/stderr chunk - used for liveness/progress.
  onData?: (chunk: string) => void;
}

// Spawn a process, optionally feed stdin, and collect stdout/stderr. Times out
// only on prolonged silence (see above), so long-but-active work is never killed.
function run(
  bin: string,
  args: string[],
  stdin: string | null,
  cwd: string,
  opts: RunOpts = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: childEnv() });
    let stdout = "";
    let stderr = "";
    let settled = false;

    let idleTimer: ReturnType<typeof setTimeout>;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      fn();
    };
    const fail = (msg: string) => {
      child.kill("SIGKILL");
      done(() => reject(new Error(msg)));
    };
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => fail(`No output for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s - the CLI appears stuck.`),
        IDLE_TIMEOUT_MS,
      );
    };
    const maxTimer = setTimeout(
      () => fail(`Exceeded the ${Math.round(MAX_TIMEOUT_MS / 1000)}s hard limit.`),
      MAX_TIMEOUT_MS,
    );
    resetIdle();

    // Every chunk is a sign of life: reset the idle clock and feed liveness.
    const onChunk = (d: unknown) => {
      const s = String(d);
      resetIdle();
      try {
        opts.onData?.(s);
      } catch {
        /* never let a progress callback break the run */
      }
      return s;
    };
    child.stdout.on("data", (d) => (stdout += onChunk(d)));
    child.stderr.on("data", (d) => (stderr += onChunk(d)));
    child.on("error", (e) => done(() => reject(e)));
    child.on("close", (code) =>
      done(() =>
        code === 0
          ? resolve({ stdout, stderr })
          : reject(new Error(stderr.trim() || stdout.trim() || `exited with code ${code}`)),
      ),
    );

    if (stdin != null) child.stdin.write(stdin);
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

async function runClaude(
  model: string,
  messages: ChatMessage[],
  workdir?: string,
  planMode?: boolean,
  onActivity?: ActivityFn,
): Promise<CallResult> {
  const bin = resolveBin("claude", CLAUDE_CANDIDATES);
  if (!bin) throw new Error("Claude CLI not found. Install it or set FUSE_CLAUDE_BIN.");
  const { system, prompt } = render(messages);
  const { cwd, scoped } = await pickCwd(workdir);

  // stream-json + partial messages → the CLI emits one JSON event per line and
  // streams the answer token-by-token. That gives us a real heartbeat (so the
  // idle timeout only fires when genuinely stuck) and a live progress signal.
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  // "default"/empty → let the CLI use its own default model (future-proof).
  if (model && model !== "default") args.push("--model", model);
  if (system) args.push("--append-system-prompt", system);
  if (scoped && planMode) {
    // Plan mode: read the folder AND create plan files (Markdown/notes) via
    // Write - but no Edit or Bash, so it can't surgically edit existing source
    // or run commands.
    args.push("--max-turns", "40", "--allowedTools", "Read", "Glob", "Grep", "Write");
  } else if (scoped) {
    // Full access to the folder - all tools, edits, and shell - like running
    // `claude` in that directory and approving everything.
    args.push("--max-turns", "60", "--permission-mode", "bypassPermissions");
  } else {
    // No folder: a pure text answer - plan synthesis (review/harden/finalize) or
    // plain chat. The model must NOT touch tools here. `--permission-mode
    // default` alone does not remove tools; it only prompts for them, and in
    // headless `-p` mode every prompt auto-denies. The model then retries the
    // denied Bash/Read/grep calls (e.g. to "verify the codebase" the plan
    // mentions) until it exhausts --max-turns and fails with error_max_turns
    // instead of producing the plan. Explicitly empty the toolset so the tools
    // are gone, not merely gated, and the answer comes back in a single turn.
    args.push(
      "--max-turns", "8",
      "--permission-mode", "default",
      "--disallowedTools",
      "Bash", "Read", "Edit", "Write", "Glob", "Grep",
      "Task", "WebFetch", "WebSearch", "NotebookEdit",
    );
  }

  // Live progress: count assistant text as it streams in. JSON objects are
  // line-delimited, so buffer across chunk boundaries before parsing.
  let streamed = 0;
  let buf = "";
  const onData: RunOpts["onData"] = onActivity
    ? (chunk) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("{")) continue;
          try {
            const ev = JSON.parse(line);
            const inner = ev?.type === "stream_event" ? ev.event : null;
            if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta" && inner.delta.text) {
              streamed += inner.delta.text.length;
              onActivity({ chars: streamed });
            }
          } catch {
            /* partial or non-event line */
          }
        }
      }
    : undefined;

  const { stdout } = await run(bin, args, prompt, cwd, { onData });

  // The final `result` event carries the answer + usage (same shape the old
  // --output-format json returned at the top level).
  let data: any = null;
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const ev = JSON.parse(s);
      if (ev?.type === "result") data = ev;
    } catch {
      /* skip non-JSON / partial lines */
    }
  }
  if (!data) throw new Error(`Unexpected claude output: ${stdout.slice(0, 200)}`);
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

async function runCodex(
  model: string,
  messages: ChatMessage[],
  workdir?: string,
  _planMode?: boolean,
  onActivity?: ActivityFn,
): Promise<CallResult> {
  const bin = resolveBin("codex", CODEX_CANDIDATES);
  if (!bin) throw new Error("Codex CLI not found. Install it or set FUSE_CODEX_BIN.");
  const { system, prompt } = render(messages);
  const { cwd, scoped } = await pickCwd(workdir);

  const full = system ? `${system}\n\n${prompt}` : prompt;
  // Keep the output file out of the (possibly user-owned) folder.
  await fs.mkdir(WORKDIR, { recursive: true });
  const outFile = path.join(WORKDIR, `codex-${Date.now()}-${codexSeq++}.txt`);
  // Folder set → workspace-write so it can create plan files (and, in normal
  // chat, implement). No folder → read-only.
  const sandbox = scoped ? "workspace-write" : "read-only";
  // medium reasoning is plenty and far faster - Codex's default (xhigh) can
  // take minutes on long answers and blow past the timeout.
  const args = ["exec", "--skip-git-repo-check", "--sandbox", sandbox, "-C", cwd, "-o", outFile, "-c", "model_reasoning_effort=medium"];
  if (model && model !== "default") args.push("-m", model);
  args.push(full);

  // Codex prints its reasoning/progress to stdout+stderr as it works, so the
  // running byte count is a fine "still alive" signal (the answer itself is read
  // from outFile below).
  let streamed = 0;
  const onData: RunOpts["onData"] = onActivity
    ? (chunk) => {
        streamed += chunk.length;
        onActivity({ chars: streamed });
      }
    : undefined;

  try {
    await run(bin, args, null, cwd, { onData });
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
  planMode?: boolean,
  onActivity?: ActivityFn,
): Promise<CallResult> {
  return provider === "claude-cli"
    ? runClaude(model, messages, workdir, planMode, onActivity)
    : runCodex(model, messages, workdir, planMode, onActivity);
}

// --- Setup / health checks --------------------------------------------------
// Used by the first-run setup gate so a new user can confirm their machine is
// ready before using Fuse.
export interface CliStatus {
  ok: boolean;
  path: string | null;
  version?: string;
  error?: string;
}

// Spawn `<bin> --version` with a short timeout to confirm the CLI is not just
// present but actually runnable.
function probeVersion(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["--version"], { env: childEnv() });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out running --version"));
    }, 10_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(out.trim() || `exited with code ${code}`));
    });
  });
}

async function probeCli(name: string, candidates: (string | undefined)[]): Promise<CliStatus> {
  const bin = resolveBin(name, candidates);
  if (!bin) return { ok: false, path: null };
  try {
    const out = await probeVersion(bin);
    return { ok: true, path: bin, version: out.split("\n")[0].slice(0, 100) };
  } catch (e: any) {
    // Found on disk but won't run (broken install, perms, etc.).
    return { ok: false, path: bin, error: e?.message ?? String(e) };
  }
}

export async function detectClis(): Promise<{ claude: CliStatus; codex: CliStatus }> {
  const [claude, codex] = await Promise.all([
    probeCli("claude", CLAUDE_CANDIDATES),
    probeCli("codex", CODEX_CANDIDATES),
  ]);
  return { claude, codex };
}
