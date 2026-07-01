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
  usage: Usage;
}

// App configuration: API keys + chosen proposer/aggregator models + depth.
// Lives here (shared) so both the client and the server-side settings store
// can use it.
// How the agents work:
//  normal = each answers, strongest fuses → a reply (no plan file)
//  attack = cross-critique pipeline → saved plan.md
//  relay  = relay/hand-off pipeline → saved plan.md
export type Mode = "normal" | "attack" | "relay";

export interface FuseConfig {
  proposers: ModelRef[];
  aggregator: ModelRef;
  rounds: number; // proposer layers for normal answers (kept at 1; no UI)
  workdir: string; // the chosen folder (remembered even when in chat mode)
  folderMode: boolean; // true = full access to workdir; false = plain chat (no file access)
  recentFolders: string[]; // previously selected folders, most-recent first
  mode: Mode;
  notifications: boolean; // desktop notification + sound on clarify / long-task finish
}

export const DEFAULT_CONFIG: FuseConfig = {
  proposers: [
    { provider: "claude-cli", model: "sonnet" },
    { provider: "codex-cli", model: "default" },
  ],
  aggregator: { provider: "claude-cli", model: "opus" },
  rounds: 1,
  workdir: "",
  folderMode: false,
  recentFolders: [],
  mode: "normal",
  notifications: true,
};

// Fill in any missing fields from defaults - used on read so older/partial
// stored configs still load cleanly. (Legacy fields like engine/keys are ignored.)
export function mergeConfig(p: any): FuseConfig {
  const cliOnly = (m: ModelRef) => m && (m.provider === "claude-cli" || m.provider === "codex-cli");
  const proposers: ModelRef[] = Array.isArray(p?.proposers) ? p.proposers.filter(cliOnly) : [];
  const workdir = typeof p?.workdir === "string" ? p.workdir : "";
  const folderMode = !!p?.folderMode && !!workdir;
  let mode: Mode = p?.mode === "attack" || p?.mode === "relay" ? p.mode : "normal";
  if (folderMode && mode === "normal") mode = "attack"; // folder ⇒ a plan pipeline
  return {
    proposers: proposers.length ? proposers : DEFAULT_CONFIG.proposers,
    aggregator: cliOnly(p?.aggregator) ? p.aggregator : DEFAULT_CONFIG.aggregator,
    rounds: p?.rounds ?? DEFAULT_CONFIG.rounds,
    workdir,
    folderMode,
    recentFolders: Array.isArray(p?.recentFolders)
      ? p.recentFolders.filter((x: any) => typeof x === "string" && x).slice(0, 12)
      : [],
    mode,
    notifications: p?.notifications !== false,
  };
}

// One message in a conversation transcript. Shared by the live chat, the
// localStorage history store, and the history/debug pages.
export interface Turn {
  role: "user" | "assistant";
  content: string;
  proposals?: Proposal[]; // per-agent answers behind a fused assistant reply
  images?: ImagePart[]; // attached images (shown as thumbnails)
  files?: string[]; // attached text-file names (shown as chips)
  fileText?: string; // inlined file contents - sent to models, not displayed/stored
  planFiles?: string[]; // absolute paths of plan files produced (plan mode)
  usage?: Usage; // total tokens spent producing this assistant reply (all agents + aggregator)
}
