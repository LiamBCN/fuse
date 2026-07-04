import type { UsageItem } from "./db";
import type { ErrorInfo } from "./types";

function providerFromLabel(label: string | undefined): ErrorInfo["provider"] | undefined {
  if (!label) return undefined;
  if (/claude/i.test(label)) return "claude";
  if (/codex/i.test(label)) return "codex";
  return undefined;
}

function parseResetTime(message: string): number | undefined {
  const iso = message.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/);
  if (iso) {
    const parsed = Date.parse(iso[0]);
    if (Number.isFinite(parsed)) return parsed;
  }

  const match = message.match(/\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i);
  if (!match) return undefined;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const AUTH_RE =
  /(Claude CLI not authenticated|not logged in|please run \/login|authentication_failed|invalid api key|setup-token)/i;
const RATE_LIMIT_RE = /hit your session limit|api_error_status["\s:]*429|rate.?limit|usage limit|too many requests/i;
const TIMEOUT_RE = /No output for \d+s|Exceeded the \d+s hard limit/i;

export function classifyCliError(
  message: string,
  context: Partial<Pick<ErrorInfo, "provider" | "stage" | "providerModel">> = {},
): ErrorInfo {
  const detail = message || "Unknown CLI error.";
  const provider = context.provider ?? providerFromLabel(context.providerModel);
  const base = {
    provider,
    stage: context.stage,
    providerModel: context.providerModel,
    message: detail,
  };
  if (/^Run stopped\.?$/i.test(detail.trim())) return { ...base, kind: "stopped" };
  if (RATE_LIMIT_RE.test(detail)) return { ...base, kind: "rate-limit", resetsAt: parseResetTime(detail) };
  if (AUTH_RE.test(detail)) return { ...base, kind: "auth" };
  if (TIMEOUT_RE.test(detail)) return { ...base, kind: "timeout" };
  return { ...base, kind: "unknown" };
}

export class AgentFailedError extends Error {
  public info: ErrorInfo;

  constructor(
    public stageTitle: string,
    public providerModel: string,
    cause: string,
    public usageItems: UsageItem[],
  ) {
    super(`${stageTitle} (${providerModel}) failed: ${cause}. Run stopped.`);
    this.info = classifyCliError(cause, {
      stage: stageTitle,
      providerModel,
      provider: providerFromLabel(providerModel),
    });
  }
}

export class RunStoppedError extends Error {
  constructor(public usageItems: UsageItem[]) {
    super("Run stopped.");
  }
}

const g = globalThis as typeof globalThis & {
  __fuseRuns?: Map<string, Set<AbortController>>;
};
const registry = (g.__fuseRuns ??= new Map());

export function registerRun(conversationId: string, ac: AbortController): () => void {
  const set = registry.get(conversationId) ?? new Set<AbortController>();
  set.add(ac);
  registry.set(conversationId, set);
  return () => {
    const current = registry.get(conversationId);
    if (!current) return;
    current.delete(ac);
    if (current.size === 0) registry.delete(conversationId);
  };
}

export function stopRuns(conversationId: string): boolean {
  const set = registry.get(conversationId);
  if (!set?.size) return false;
  registry.delete(conversationId);
  for (const ac of set) ac.abort();
  return true;
}

export function hasRun(conversationId: string): boolean {
  return !!registry.get(conversationId)?.size;
}
