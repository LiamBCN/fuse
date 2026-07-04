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
import type { ActivityFn, CallResult, ChatMessage, CliSandbox, CliSession } from "./providers";
import { readSettings } from "./settings-store";
import type { Effort } from "./types";

// Per-call CLI options threaded down from callModel (lib/providers.ts).
export interface CliOpts {
  session?: CliSession; // claude-cli: --session-id / --resume
  reasoningEffort?: Effort; // per-call effort override → claude --effort / codex model_reasoning_effort
  sandbox?: CliSandbox; // codex-cli: override the default sandbox for this call
  signal?: AbortSignal;
}

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

const childEnv = (extra?: Record<string, string>) => {
  const { CLAUDE_CODE_OAUTH_TOKEN: _dropClaudeToken, ...base } = process.env;
  return {
    ...base,
    HOME,
    PATH: [...EXTRA_DIRS, process.env.PATH || ""].join(":"),
    ...extra,
  };
};

const CLAUDE_AUTH_MESSAGE = "Claude CLI not authenticated - run `claude setup-token` and paste the token in Settings.";

function isClaudeAuthFailure(s: string | undefined): boolean {
  // NB: do NOT key off `apiKeySource:"none"`. Subscription/OAuth logins have no
  // API key, so the CLI's init event always reports apiKeySource:"none" even when
  // fully authenticated. Since runClaude scans the whole stream-json stdout, that
  // line would relabel any is_error (e.g. a 429 session limit) as an auth failure
  // and misdirect users to `claude setup-token`. The genuine logged-out signals
  // below are what actually distinguish "not authenticated".
  return !!s && /(not logged in|please run \/login|authentication_failed|invalid api key)/i.test(s);
}

async function claudeOauthToken(): Promise<string | undefined> {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) return envToken;
  try {
    return (await readSettings()).claudeOauthToken?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function claudeEnv(): Promise<Record<string, string> | undefined> {
  const token = await claudeOauthToken();
  return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : undefined;
}

// The user's configured reasoning effort (Settings ▸ Effort). Applied to every
// model call as the default; a per-call opts.reasoningEffort still wins.
async function configuredEffort(): Promise<Effort> {
  try {
    return (await readSettings()).effort;
  } catch {
    return "high";
  }
}

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
  env?: Record<string, string>;
  signal?: AbortSignal;
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
    if (opts.signal?.aborted) {
      reject(new Error("Run stopped."));
      return;
    }

    const child = spawn(bin, args, { cwd, env: childEnv(opts.env), detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let maxTimer: ReturnType<typeof setTimeout> | undefined;
    const killTree = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* process may already be gone */
        }
      }
    };
    const onAbort = () => fail("Run stopped.");
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (maxTimer) clearTimeout(maxTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const fail = (msg: string) => {
      killTree();
      done(() => reject(new Error(msg)));
    };
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => fail(`No output for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s - the CLI appears stuck.`),
        IDLE_TIMEOUT_MS,
      );
    };
    maxTimer = setTimeout(
      () => fail(`Exceeded the ${Math.round(MAX_TIMEOUT_MS / 1000)}s hard limit.`),
      MAX_TIMEOUT_MS,
    );
    opts.signal?.addEventListener("abort", onAbort);
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

function withoutMaxTurns(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max-turns") {
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function isUnknownMaxTurnsError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /--max-turns/.test(msg) && /(unknown|unrecognized|unsupported|unexpected|invalid).*(option|argument|flag)/i.test(msg);
}

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
  opts?: CliOpts,
): Promise<CallResult> {
  const bin = resolveBin("claude", CLAUDE_CANDIDATES);
  if (!bin) throw new Error("Claude CLI not found. Install it or set FUSE_CLAUDE_BIN.");
  const { system, prompt } = render(messages);
  const { cwd, scoped } = await pickCwd(workdir);
  const env = await claudeEnv();

  // stream-json + partial messages → the CLI emits one JSON event per line and
  // streams the answer token-by-token. That gives us a real heartbeat (so the
  // idle timeout only fires when genuinely stuck) and a live progress signal.
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  // "default"/empty → let the CLI use its own default model (future-proof).
  if (model && model !== "default") args.push("--model", model);
  // Reasoning effort (Settings ▸ Effort; a per-call override wins). Claude Code
  // maps --effort to its extended-thinking budget. Verified on CLI 2.1.199.
  args.push("--effort", opts?.reasoningEffort ?? (await configuredEffort()));
  if (system) args.push("--append-system-prompt", system);
  // Session reuse across pipeline stages: pin a fresh session's UUID, or resume
  // one a prior stage created. A resumed process replays the transcript
  // (including tool results), and --append-system-prompt swaps cleanly per
  // turn, so a later stage keeps every file the earlier stage read in context
  // while running under its own stage prompt (both verified against 2.1.198).
  if (opts?.session?.resume) args.push("--resume", opts.session.resume);
  else if (opts?.session?.id) args.push("--session-id", opts.session.id);
  if (scoped && planMode) {
    // Plan mode: read the folder AND create plan files (Markdown/notes) via
    // Write - but no Edit or Bash, so it can't surgically edit existing source
    // or run commands. 80 turns (up from 40): the grounded modes' recon/verify
    // stages fact-check many claims with lots of small Read/Grep calls, so a
    // drafter-sized budget would starve them and fail-fast the whole run.
    args.push("--max-turns", "80", "--allowedTools", "Read", "Glob", "Grep", "Write");
  } else if (scoped) {
    // Full access to the folder - all tools, edits, and shell - like running
    // `claude` in that directory and approving everything.
    args.push("--max-turns", "60", "--permission-mode", "bypassPermissions");
  } else {
    // No folder: a pure text answer - plan synthesis (review/harden/finalize) or
    // plain chat. Disable tools outright with `--tools ""` so the model can't run
    // anything and just writes the answer in a single turn.
    //
    // `--permission-mode default` alone was NOT enough: default mode still lets
    // the read-only tools (Read/Glob/Grep) run without a prompt, so the
    // aggregator would wander off "verifying the codebase" the plan mentions,
    // exhaust the turn budget, and fail with `error_max_turns` - the "Reached
    // maximum number of turns" error users kept hitting on review/synthesis
    // steps. With no tools available there's nothing to loop on. The generous
    // --max-turns is just a backstop; a tool-less answer completes in one turn.
    args.push("--tools", "", "--permission-mode", "default", "--max-turns", "40");
  }

  // Live progress: count assistant text as it streams in. JSON objects are
  // line-delimited, so buffer across chunk boundaries before parsing.
  let streamed = 0;
  let tail = "";
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
              tail = (tail + inner.delta.text).slice(-1500);
              onActivity({ chars: streamed, tail });
            }
          } catch {
            /* partial or non-event line */
          }
        }
      }
    : undefined;

  let stdout: string;
  try {
    ({ stdout } = await run(bin, args, prompt, cwd, { onData, env, signal: opts?.signal }));
  } catch (e) {
    if (isClaudeAuthFailure(e instanceof Error ? e.message : String(e))) throw new Error(CLAUDE_AUTH_MESSAGE);
    if (!isUnknownMaxTurnsError(e)) throw e;
    try {
      ({ stdout } = await run(bin, withoutMaxTurns(args), prompt, cwd, { onData, env, signal: opts?.signal }));
    } catch (retryError) {
      if (isClaudeAuthFailure(retryError instanceof Error ? retryError.message : String(retryError))) {
        throw new Error(CLAUDE_AUTH_MESSAGE);
      }
      throw retryError;
    }
  }

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
  if (data.is_error) {
    const msg = data.result || "claude CLI error";
    if (isClaudeAuthFailure(msg) || isClaudeAuthFailure(stdout)) throw new Error(CLAUDE_AUTH_MESSAGE);
    throw new Error(msg);
  }

  const u = data.usage ?? {};
  const prompt_tokens =
    (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const completion_tokens = u.output_tokens ?? 0;
  return {
    content: data.result ?? "",
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
    sessionId: typeof data.session_id === "string" ? data.session_id : undefined,
  };
}

let codexSeq = 0;

async function runCodex(
  model: string,
  messages: ChatMessage[],
  workdir?: string,
  planMode?: boolean,
  onActivity?: ActivityFn,
  opts?: CliOpts,
): Promise<CallResult> {
  const bin = resolveBin("codex", CODEX_CANDIDATES);
  if (!bin) throw new Error("Codex CLI not found. Install it or set FUSE_CODEX_BIN.");
  const { system, prompt } = render(messages);
  const { cwd, scoped } = await pickCwd(workdir);

  const full = system ? `${system}\n\n${prompt}` : prompt;
  // Keep the output file out of the (possibly user-owned) folder.
  await fs.mkdir(WORKDIR, { recursive: true });
  const outFile = path.join(WORKDIR, `codex-${Date.now()}-${codexSeq++}.txt`);
  // Folder set → workspace-write so drafts can create scratch plan files (and,
  // in normal chat, implement). Plan-mode closing stages can override to
  // read-only because their job is verification/finalization, not file writes.
  const sandbox = opts?.sandbox ?? (scoped && planMode ? "workspace-write" : scoped ? "workspace-write" : "read-only");
  // Reasoning effort follows the user's Settings ▸ Effort (default high); a
  // per-call opts.reasoningEffort still overrides. We deliberately don't expose
  // Codex's own xhigh here — it can take minutes and blow past the idle timeout.
  const effort = opts?.reasoningEffort ?? (await configuredEffort());
  // --json → line-delimited events on stdout: thread.started carries the
  // resumable thread_id, turn.completed carries REAL token usage (the answer
  // still comes from -o outFile, which stays authoritative).
  const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", sandbox, "-C", cwd, "-o", outFile, "-c", `model_reasoning_effort=${effort}`];
  if (model && model !== "default") args.push("-m", model);
  args.push(full);

  // Codex prints its progress events to stdout+stderr as it works, so the
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
    const { stdout } = await run(bin, args, null, cwd, { onData, signal: opts?.signal });

    // Pull real usage + the session/thread id out of the JSONL event stream.
    let usage: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | null = null;
    let threadId: string | undefined;
    for (const line of stdout.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("{")) continue;
      try {
        const ev = JSON.parse(s);
        if (ev?.type === "thread.started" && typeof ev.thread_id === "string") threadId = ev.thread_id;
        if (ev?.type === "turn.completed" && ev.usage) usage = ev.usage;
      } catch {
        /* partial or non-event line */
      }
    }

    const content = (await fs.readFile(outFile, "utf8")).trim();
    // Real numbers when --json reported them; length/4 estimates as fallback so
    // usage never silently reads as zero if the event shape drifts. Codex's
    // input_tokens already includes cached_input_tokens (OpenAI convention).
    const prompt_tokens = usage ? (usage.input_tokens ?? 0) : estTokens(full);
    const completion_tokens = usage ? (usage.output_tokens ?? 0) : estTokens(content);
    return {
      content,
      usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
      sessionId: threadId,
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
  opts?: CliOpts,
): Promise<CallResult> {
  return provider === "claude-cli"
    ? runClaude(model, messages, workdir, planMode, onActivity, opts)
    : runCodex(model, messages, workdir, planMode, onActivity, opts);
}

// --- Setup / health checks --------------------------------------------------
// Used by the first-run setup gate so a new user can confirm their machine is
// ready before using Fuse.
export interface CliStatus {
  ok: boolean;
  path: string | null;
  version?: string;
  loggedIn?: boolean;
  tokenConfigured?: boolean;
  authError?: string;
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

function probeClaudeAuthOnce(
  bin: string,
  args: string[],
  env: Record<string, string> | undefined,
): Promise<{ loggedIn: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: os.tmpdir(), env: childEnv(env) });
    let out = "";
    let err = "";
    const finish = (loggedIn: boolean, error?: string) => resolve({ loggedIn, error });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, "Timed out checking Claude auth");
    }, 25_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      finish(false, e.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = `${out}\n${err}`.trim();
      if (isClaudeAuthFailure(text)) return finish(false, CLAUDE_AUTH_MESSAGE);
      let data: any = null;
      for (const line of out.split("\n")) {
        const s = line.trim();
        if (!s.startsWith("{")) continue;
        try {
          data = JSON.parse(s);
        } catch {
          /* skip */
        }
      }
      if (data?.is_error) {
        const msg = data.result || text || "Claude auth check failed";
        return finish(!isClaudeAuthFailure(msg) && code === 0, msg);
      }
      if (code === 0) return finish(true);
      finish(false, text || `exited with code ${code}`);
    });
  });
}

async function probeClaudeAuth(
  bin: string,
  env: Record<string, string> | undefined,
): Promise<{ loggedIn: boolean; error?: string }> {
  const withTools = ["-p", "Reply with exactly ok.", "--output-format", "json", "--tools", ""];
  const first = await probeClaudeAuthOnce(bin, withTools, env);
  if (first.error && /--tools|unknown|unrecognized|unsupported|unexpected|invalid/i.test(first.error)) {
    return probeClaudeAuthOnce(bin, ["-p", "Reply with exactly ok.", "--output-format", "json"], env);
  }
  return first;
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

async function probeClaudeCli(): Promise<CliStatus> {
  const bin = resolveBin("claude", CLAUDE_CANDIDATES);
  if (!bin) return { ok: false, path: null, loggedIn: false, tokenConfigured: !!(await claudeOauthToken()) };
  try {
    const out = await probeVersion(bin);
    const env = await claudeEnv();
    const auth = await probeClaudeAuth(bin, env);
    return {
      ok: true,
      path: bin,
      version: out.split("\n")[0].slice(0, 100),
      loggedIn: auth.loggedIn,
      tokenConfigured: !!env?.CLAUDE_CODE_OAUTH_TOKEN,
      authError: auth.loggedIn ? undefined : auth.error,
    };
  } catch (e: any) {
    // Found on disk but won't run (broken install, perms, etc.).
    return {
      ok: false,
      path: bin,
      loggedIn: false,
      tokenConfigured: !!(await claudeOauthToken()),
      error: e?.message ?? String(e),
    };
  }
}

export async function detectClis(): Promise<{ claude: CliStatus; codex: CliStatus }> {
  const [claude, codex] = await Promise.all([
    probeClaudeCli(),
    probeCli("codex", CODEX_CANDIDATES),
  ]);
  return { claude, codex };
}
