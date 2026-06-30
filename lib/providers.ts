// Model-calling layer. Fuse is CLI-only: every call is routed to a local CLI
// (Claude Code / Codex) via lib/cli.ts. No HTTP APIs, no API keys.
import type { ProviderId } from "./models";
import type { Usage, ImagePart } from "./types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: ImagePart[]; // accepted for shape compatibility; CLIs are text-only
}

export interface CallResult {
  content: string;
  usage: Usage;
}

// Liveness callback: fired as the CLI streams output so the UI can show that a
// long stage is actively working (and isn't stuck). `chars` is cumulative.
export interface ActivityInfo {
  chars: number;
}
export type ActivityFn = (info: ActivityInfo) => void;

export interface CallArgs {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  workdir?: string; // folder the CLI agent may work in (full access when set)
  planMode?: boolean; // Plan Mode: may create plan files but not edit source / run code
  onActivity?: ActivityFn; // progress heartbeat while the CLI streams output
}

export async function callModel(args: CallArgs): Promise<CallResult> {
  const { runCli } = await import("./cli");
  return runCli(args.provider, args.model, args.messages, args.workdir, args.planMode, args.onActivity);
}
