// Shared types used across client and server. Kept free of any server-only
// imports (no fs/db) so it is safe to import from React components.
import type { ProviderId } from "./models";

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type LimitProvider = "claude" | "codex";

export interface LimitWindow {
  usedPercent: number;
  resetsAt: number | null;
  windowMinutes: number;
}

export interface ProviderLimits {
  provider: LimitProvider;
  session: LimitWindow | null;
  weekly: LimitWindow | null;
  scoped?: { label: string; usedPercent: number }[];
  planType?: string;
  fetchedAt: number;
  error?: string;
}

export interface LimitSnapshot {
  claude: ProviderLimits;
  codex: ProviderLimits;
}

export interface ProviderLimitDelta {
  sessionDeltaPct: number;
  weeklyDeltaPct: number;
}

export interface UsageLimitDeltas {
  claude?: ProviderLimitDelta;
  codex?: ProviderLimitDelta;
  approx?: boolean;
}

export interface ErrorInfo {
  kind: "rate-limit" | "auth" | "timeout" | "stopped" | "unknown";
  provider?: LimitProvider;
  stage?: string;
  providerModel?: string;
  message: string;
  resetsAt?: number;
  limits?: LimitSnapshot;
}

// An attached image, base64-encoded (no data: prefix), e.g. for vision models.
export interface ImagePart {
  mediaType: string; // e.g. "image/png"
  dataBase64: string;
}

export interface Proposal {
  provider: ProviderId;
  model: string;
  content: string;
  error?: string;
  errorInfo?: ErrorInfo;
  usage: Usage;
}

// App configuration: API keys + chosen proposer/aggregator models + depth.
// Lives here (shared) so both the client and the server-side settings store
// can use it.
// How the agents work:
//  fast   = speed: 2 grounded drafts in parallel → one grounded verify-and-finalize pass → plan.md
//  relay  = classic hand-off compressed: 2 grounded drafts → blind harden-and-finalize → plan.md
//  recon  = power: clarify/recon/drafts overlap → one verify-and-finalize pass → plan.md,
//           with the finalizer resuming the recon CLI session when available
export type Mode = "fast" | "relay" | "recon";

// All selectable modes are plan modes when a folder/workdir is present.
export type PlanMode = Mode;

// Reasoning effort applied to every model call (both providers). Codex maps it
// to `model_reasoning_effort`; Claude maps it to an extended-thinking budget.
export type Effort = "low" | "medium" | "high";

export type StageKey = "clarify" | "recon" | "draftA" | "draftB" | "harden" | "verify" | "synthesize" | "finalize";
export type StageModelMap = Partial<Record<StageKey, ModelRef>>;
export type StageStatus = "pending" | "running" | "done" | "error" | "skipped";

export interface StageInfo {
  key: StageKey | string;
  title: string;
  provider: string;
  model: string;
  status: StageStatus;
  chars?: number;
  tail?: string;
  output?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface FuseConfig {
  proposers: ModelRef[];
  aggregator: ModelRef;
  stageModels?: StageModelMap; // optional per-plan-stage overrides
  rounds: number; // proposer layers for normal answers (kept at 1; no UI)
  workdir: string; // the chosen folder (remembered even when in chat mode)
  folderMode: boolean; // true = full access to workdir; false = plain chat (no file access)
  recentFolders: string[]; // previously selected folders, most-recent first
  mode: Mode;
  effort: Effort; // reasoning effort for every model call (both providers)
  notifications: boolean; // desktop notification + sound on clarify / long-task finish
  claudeOauthToken?: string; // server-side only; redacted from settings GET/localStorage
  claudeOauthTokenSet?: boolean; // client-visible status bit
  benchResultsRepo?: string; // local Fuse clone to publish benchmark results into (git). Empty → dev cwd fallback.
  benchAutoPublish?: boolean; // publish each finished benchmark to the results repo automatically
}

export const DEFAULT_CONFIG: FuseConfig = {
  proposers: [
    { provider: "claude-cli", model: "claude-sonnet-5" },
    { provider: "codex-cli", model: "default" },
  ],
  aggregator: { provider: "claude-cli", model: "claude-opus-4-8" },
  stageModels: {},
  rounds: 1,
  workdir: "",
  folderMode: false,
  recentFolders: [],
  mode: "fast",
  effort: "high",
  notifications: true,
  claudeOauthTokenSet: false,
  benchResultsRepo: "",
  benchAutoPublish: false,
};

// Fill in any missing fields from defaults - used on read so older/partial
// stored configs still load cleanly. (Legacy fields like engine/keys are ignored.)
export function mergeConfig(p: any): FuseConfig {
  const cliOnly = (m: any): m is ModelRef =>
    m && (m.provider === "claude-cli" || m.provider === "codex-cli") && typeof m.model === "string" && m.model.trim().length > 0;
  const proposers: ModelRef[] = Array.isArray(p?.proposers) ? p.proposers.filter(cliOnly) : [];
  const workdir = typeof p?.workdir === "string" ? p.workdir : "";
  const folderMode = !!p?.folderMode && !!workdir;
  const stageKeys = new Set<StageKey>(["clarify", "recon", "draftA", "draftB", "harden", "verify", "synthesize", "finalize"]);
  const stageModels: StageModelMap = {};
  if (p?.stageModels && typeof p.stageModels === "object") {
    for (const [key, value] of Object.entries(p.stageModels)) {
      if (stageKeys.has(key as StageKey) && cliOnly(value)) {
        stageModels[key as StageKey] = { provider: value.provider, model: value.model.trim() };
      }
    }
  }
  const claudeOauthToken =
    typeof p?.claudeOauthToken === "string" && p.claudeOauthToken.trim()
      ? p.claudeOauthToken.trim()
      : undefined;
  const rawMode = p?.mode;
  const mode: Mode =
    rawMode === "fast" || rawMode === "relay" || rawMode === "recon"
      ? rawMode
      : rawMode === "normal"
        ? "fast"
        : rawMode === "deep" || rawMode === "attack"
          ? "recon"
          : rawMode === "relay2"
            ? "relay"
            : DEFAULT_CONFIG.mode;
  const effort: Effort =
    p?.effort === "low" || p?.effort === "medium" || p?.effort === "high" ? p.effort : DEFAULT_CONFIG.effort;
  return {
    proposers: proposers.length ? proposers : DEFAULT_CONFIG.proposers,
    aggregator: cliOnly(p?.aggregator) ? p.aggregator : DEFAULT_CONFIG.aggregator,
    stageModels,
    rounds: p?.rounds ?? DEFAULT_CONFIG.rounds,
    workdir,
    folderMode,
    recentFolders: Array.isArray(p?.recentFolders)
      ? p.recentFolders.filter((x: any) => typeof x === "string" && x).slice(0, 12)
      : [],
    mode,
    effort,
    notifications: p?.notifications !== false,
    claudeOauthToken,
    claudeOauthTokenSet: !!p?.claudeOauthTokenSet || !!claudeOauthToken,
    benchResultsRepo: typeof p?.benchResultsRepo === "string" ? p.benchResultsRepo : "",
    benchAutoPublish: !!p?.benchAutoPublish,
  };
}

// One message in a conversation transcript. Shared by the live chat, the
// localStorage history store, and the history/debug pages.
export interface Turn {
  role: "user" | "assistant";
  content: string;
  mode?: Mode; // which pipeline produced this assistant reply (absent on user turns & legacy data)
  proposals?: Proposal[]; // per-agent answers behind a fused assistant reply
  images?: ImagePart[]; // attached images (shown as thumbnails)
  files?: string[]; // attached text-file names (shown as chips)
  fileText?: string; // inlined file contents - sent to models, not displayed/stored
  planFiles?: string[]; // absolute paths of plan files produced (plan mode)
  usage?: Usage; // total tokens spent producing this assistant reply (all agents + aggregator)
  limits?: UsageLimitDeltas; // approximate account limit utilization during this turn
}
