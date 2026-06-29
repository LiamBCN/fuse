// Provider + model catalog and best-effort pricing.
// Prices are USD per 1,000,000 tokens. They drift over time — edit freely,
// or override per-model in the Settings page. Unknown models cost $0 (tokens
// are still tracked; only the cost estimate is affected).

// Fuse runs purely on local CLIs (Claude Code, Codex) via your subscription
// logins. No metered HTTP APIs, no API keys.
export type ProviderId = "claude-cli" | "codex-cli";

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  defaultModels: string[];
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: "claude-cli",
    label: "Claude",
    // claude CLI accepts short aliases (always the latest of each tier) and
    // full version ids.
    defaultModels: ["sonnet", "opus", "haiku", "claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"],
  },
  {
    id: "codex-cli",
    label: "Codex",
    // "default" lets Codex pick the model your login allows (explicit ids like
    // gpt-5-codex are rejected on a ChatGPT-account login).
    defaultModels: ["default"],
  },
];

// Subscription-based — no per-token cost to estimate.
export function estimateCost(_model: string, _promptTokens: number, _completionTokens: number): number {
  return 0;
}
