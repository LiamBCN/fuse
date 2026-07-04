"use client";
import { useEffect, useMemo, useState } from "react";
import { formatResetAt, LimitMeter } from "@/components/LimitMeter";
import { providerLabel } from "@/lib/limit-format";
import type { ErrorInfo } from "@/lib/types";

function titleFor(info: ErrorInfo | undefined, fallback: string): string {
  if (!info) return fallback || "Run failed";
  const provider = info.provider ? providerLabel(info.provider) : "Agent";
  if (info.kind === "rate-limit") return `${provider} usage limit reached`;
  if (info.kind === "auth") return `${provider} CLI not authenticated`;
  if (info.kind === "timeout") return "Agent timed out";
  if (info.kind === "stopped") return "Run stopped";
  return "Run failed";
}

function tone(kind: ErrorInfo["kind"] | undefined): string {
  if (kind === "rate-limit") return "border-amber-500/50 bg-amber-500/5 text-amber-700 dark:text-amber-300";
  if (kind === "auth") return "border-red-500/50 bg-red-500/5 text-red-600 dark:text-red-400";
  if (kind === "timeout") return "border-amber-500/50 bg-amber-500/5 text-amber-700 dark:text-amber-300";
  return "border-border bg-subtle text-fg";
}

export default function ErrorBanner({
  error,
  info,
  onRetry,
}: {
  error: string;
  info?: ErrorInfo | null;
  onRetry?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!info?.resetsAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [info?.resetsAt]);

  const retryDisabled = !!info?.resetsAt && info.resetsAt > now;
  const subtitle = useMemo(() => {
    const parts = [info?.stage, info?.providerModel].filter(Boolean);
    return parts.join(" · ");
  }, [info?.stage, info?.providerModel]);

  return (
    <div className={`mt-10 rounded-2xl border p-5 ${tone(info?.kind)}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-base font-semibold">{titleFor(info ?? undefined, error)}</div>
          {subtitle && <div className="mt-1 text-sm opacity-80">{subtitle}</div>}
          {info?.kind === "rate-limit" && (
            <div className="mt-2 text-sm font-medium">
              {info.resetsAt ? formatResetAt(info.resetsAt) : "Reset time unavailable."}
            </div>
          )}
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            disabled={retryDisabled}
            className="rounded-full border border-current px-4 py-2 text-sm font-medium transition hover:bg-current/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Retry
          </button>
        )}
      </div>

      {info?.kind === "rate-limit" && info.limits && (
        <div className="mt-4 rounded-xl border border-current/20 bg-bg/50 p-3 text-fg">
          <LimitMeter limits={info.limits} />
        </div>
      )}

      <details className="mt-4 text-sm">
        <summary className="cursor-pointer opacity-80">Details</summary>
        <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words font-mono text-xs opacity-80">
          {info?.message || error}
        </pre>
      </details>
    </div>
  );
}
