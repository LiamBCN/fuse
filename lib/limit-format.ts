import type { LimitProvider, ProviderLimitDelta, UsageLimitDeltas } from "./types";

export function formatPercent(value: number | undefined, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(value >= 10 ? 0 : digits)}%`;
}

export function formatDeltaPercent(value: number | undefined, tokens?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0 && tokens && tokens > 0) return "<1%";
  return formatPercent(value);
}

export function providerLabel(provider: LimitProvider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

export function formatProviderDelta(
  provider: LimitProvider,
  delta: ProviderLimitDelta | undefined,
  tokens?: number,
): string | null {
  if (!delta) return null;
  const label = providerLabel(provider);
  return `${formatDeltaPercent(delta.sessionDeltaPct, tokens)} ${label} 5h · ${formatDeltaPercent(delta.weeklyDeltaPct, tokens)} weekly`;
}

export function formatLimitDeltas(limits: UsageLimitDeltas | undefined, tokens?: number): string {
  if (!limits) return "";
  const parts = [
    formatProviderDelta("claude", limits.claude, tokens),
    formatProviderDelta("codex", limits.codex, tokens),
  ].filter((part): part is string => !!part);
  return parts.length ? `≈${parts.join(" · ≈")}` : "";
}

export function totalSessionDelta(limits: UsageLimitDeltas | undefined): number {
  return (limits?.claude?.sessionDeltaPct ?? 0) + (limits?.codex?.sessionDeltaPct ?? 0);
}

export function totalWeeklyDelta(limits: UsageLimitDeltas | undefined): number {
  return (limits?.claude?.weeklyDeltaPct ?? 0) + (limits?.codex?.weeklyDeltaPct ?? 0);
}
