"use client";
// App-level generation runtime. Generations are owned here - in a module
// singleton - not inside the chat page, so they keep running when you navigate
// away (to History, to a new chat, etc.) and several conversations can generate
// at once. Components subscribe via useSyncExternalStore to render live status.
//
// On completion the runtime persists the assistant turn to the conversation
// itself (server-side JSON), so a result is never lost even if no page is
// mounted when it arrives.
import { saveConversation } from "./conversations";
import { notifyUser, playChime } from "./notify";
import type { ErrorInfo, Mode, Proposal, StageInfo, Turn, Usage, UsageLimitDeltas } from "./types";

export interface RunProgress {
  done: number;
  total: number;
  label: string;
  agents?: { model: string; status: "running" | "done" | "error" }[];
}

export type RunStatus = "running" | "done" | "error";

export interface RunRecord {
  convId: string;
  status: RunStatus;
  mode?: Mode;
  stages?: StageInfo[];
  progress: RunProgress | null;
  startedAt: number;
  error?: string;
  errorInfo?: ErrorInfo;
  clarify?: { questions: string[] };
}

interface StartOpts {
  turns: Turn[]; // full history INCLUDING the just-added user turn
  body: unknown; // request body for POST /api/chat
  mode?: Mode;
  notifications?: boolean;
}

type ResultEvent = {
  mode?: Mode;
  final: string;
  proposals?: Proposal[];
  usage?: Usage;
  limits?: UsageLimitDeltas;
  needsClarification?: boolean;
  questions?: string[];
  files?: string[];
};

const runs = new Map<string, RunRecord>();
const fetchControllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let version = 0;

const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

function notifyLimitsChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("fuse:limits-refresh"));
}

function mergeStages(existing: StageInfo[] | undefined, incoming: StageInfo[]): StageInfo[] {
  const prevByKey = new Map((existing ?? []).map((s) => [s.key, s]));
  const seen = new Set<string>();
  const merged = incoming.map((next) => {
    const prev = prevByKey.get(next.key);
    seen.add(next.key);
    if (!prev) return next;
    const out = { ...prev, ...next };
    if (next.output === undefined && prev.output !== undefined) out.output = prev.output;
    return out;
  });
  for (const old of existing ?? []) {
    if (!seen.has(old.key)) merged.push(old);
  }
  return merged;
}

// --- store interface for useSyncExternalStore -------------------------------
export function subscribeRuns(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function runsVersion(): number {
  return version;
}

// --- reads ------------------------------------------------------------------
export function getRun(convId: string): RunRecord | undefined {
  return runs.get(convId);
}
export function isRunning(convId: string): boolean {
  return runs.get(convId)?.status === "running";
}
export function runningConvIds(): string[] {
  return [...runs.values()].filter((r) => r.status === "running").map((r) => r.convId);
}
export function clearRun(convId: string): void {
  if (runs.delete(convId)) emit();
}

// --- driving a generation ---------------------------------------------------
export function startRun(convId: string, opts: StartOpts): void {
  // One generation per conversation at a time (concurrency is across convs).
  if (runs.get(convId)?.status === "running") return;
  const controller = new AbortController();
  fetchControllers.set(convId, controller);
  runs.set(convId, { convId, status: "running", mode: opts.mode, progress: null, startedAt: Date.now() });
  emit();
  void drive(convId, opts, controller);
}

export function stopRun(convId: string): void {
  if (runs.get(convId)?.status !== "running") return;
  clearRun(convId);
  fetchControllers.get(convId)?.abort();
  void fetch("/api/chat/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: convId }),
    keepalive: true,
  }).catch(() => {});
}

async function drive(convId: string, opts: StartOpts, controller: AbortController): Promise<void> {
  const patch = (p: Partial<RunRecord>) => {
    const cur = runs.get(convId);
    if (!cur) return;
    runs.set(convId, { ...cur, ...p });
    emit();
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      let msg = "Request failed";
      try {
        msg = (await res.json()).error || msg;
      } catch {}
      throw new Error(msg);
    }

    // Read the SSE stream: progress events, then a final result/error.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let result: ResultEvent | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 2);
        if (!raw.startsWith("data:")) continue;
        const ev = JSON.parse(raw.slice(5).trim());
        if (ev.type === "progress") {
          patch({ progress: { done: ev.done, total: ev.total, label: ev.label, agents: ev.agents } });
        } else if (ev.type === "stage") {
          const cur = runs.get(convId);
          patch({ stages: mergeStages(cur?.stages, Array.isArray(ev.stages) ? ev.stages : []) });
        } else if (ev.type === "result") {
          result = ev;
        } else if (ev.type === "error") {
          const err = Object.assign(new Error(ev.error), { info: ev.info as ErrorInfo | undefined });
          throw err;
        }
      }
    }
    if (!result) throw new Error("No response from the agents.");

    // Persist the assistant turn so the result survives even with no page open.
    const assistant: Turn = {
      role: "assistant",
      content: result.final,
      mode: result.mode ?? opts.mode,
      proposals: result.proposals,
      planFiles: result.files,
      usage: result.usage,
      limits: result.limits,
    };
    await saveConversation({ id: convId, turns: [...opts.turns, assistant] });

    patch({
      status: "done",
      mode: result.mode ?? opts.mode,
      progress: null,
      clarify: result.needsClarification ? { questions: result.questions ?? [] } : undefined,
    });

    if (result.needsClarification) {
      playChime();
      if (opts.notifications) {
        notifyUser("Fuse needs a bit more info", "Answer a couple of quick questions to continue planning.");
      }
    } else if (opts.notifications && typeof document !== "undefined" && !document.hasFocus()) {
      notifyUser("Fuse finished", "Your response is ready.");
    }
    notifyLimitsChanged();
  } catch (e: any) {
    if (e?.name === "AbortError") return;
    patch({ status: "error", progress: null, error: e?.message ?? String(e), errorInfo: e?.info });
    notifyLimitsChanged();
  } finally {
    if (fetchControllers.get(convId) === controller) fetchControllers.delete(convId);
  }
}
