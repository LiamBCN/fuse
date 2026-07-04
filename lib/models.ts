// Provider + model catalog and best-effort pricing.
// Prices are USD per 1,000,000 tokens. They drift over time - edit freely,
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
    // "default" = the CLI's own default model. Claude Code also accepts
    // aliases (fable/opus/sonnet/haiku) plus full model ids.
    defaultModels: [
      "default",
      "fable",
      "opus",
      "sonnet",
      "haiku",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
    ],
  },
  {
    id: "codex-cli",
    label: "Codex",
    // "default" lets Codex pick the model your login allows. The explicit
    // slugs below are the current Codex-recommended models.
    defaultModels: ["default", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
  },
];

// Subscription-based - no per-token cost to estimate.
export function estimateCost(_model: string, _promptTokens: number, _completionTokens: number): number {
  return 0;
}
