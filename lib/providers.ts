// Model-calling layer. Fuse is CLI-only: every call is routed to a local CLI
// (Claude Code / Codex) via lib/cli.ts. No HTTP APIs, no API keys.
import type { ProviderId } from "./models";
import type { Effort, Usage, ImagePart } from "./types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: ImagePart[]; // accepted for shape compatibility; CLIs are text-only
}

export interface CallResult {
  content: string;
  usage: Usage;
  sessionId?: string; // CLI session/thread id, when the CLI reports one (resumable)
}

// Liveness callback: fired as the CLI streams output so the UI can show that a
// long stage is actively working (and isn't stuck). `chars` is cumulative.
export interface ActivityInfo {
  chars: number;
  tail?: string;
}
export type ActivityFn = (info: ActivityInfo) => void;

export type CliSandbox = "read-only" | "workspace-write";

// Cross-stage session reuse (claude-cli only for now). Pass `id` to pin a fresh
// session's UUID so later stages can `resume` it: the resumed process replays
// the whole transcript INCLUDING tool results, so files read in an earlier
// stage stay in context and don't have to be re-read or re-pasted.
export interface CliSession {
  id?: string; // start a new session under this UUID (claude --session-id)
  resume?: string; // continue an existing session (claude --resume)
}

export interface CallArgs {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  workdir?: string; // folder the CLI agent may work in (full access when set)
  planMode?: boolean; // Plan Mode: may create plan files but not edit source / run code
  onActivity?: ActivityFn; // progress heartbeat while the CLI streams output
  session?: CliSession; // reuse one CLI session across pipeline stages
  reasoningEffort?: Effort; // per-call effort override; defaults to Settings ▸ Effort for both providers
  sandbox?: CliSandbox; // codex-cli sandbox override for scoped plan stages
  signal?: AbortSignal;
}

export async function callModel(args: CallArgs): Promise<CallResult> {
  const { runCli } = await import("./cli");
  return runCli(args.provider, args.model, args.messages, args.workdir, args.planMode, args.onActivity, {
    session: args.session,
    reasoningEffort: args.reasoningEffort,
    sandbox: args.sandbox,
    signal: args.signal,
  });
}
