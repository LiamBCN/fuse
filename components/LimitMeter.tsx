"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { runningConvIds, runsVersion, subscribeRuns } from "@/lib/chat-runtime";
import { formatPercent, providerLabel } from "@/lib/limit-format";
import type { LimitProvider, LimitSnapshot, LimitWindow, ProviderLimits } from "@/lib/types";

export function formatResetAt(resetsAt: number | null | undefined): string {
  if (!resetsAt) return "reset unknown";
  const d = new Date(resetsAt);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const diff = resetsAt - Date.now();
  if (diff <= 0) return `reset ${time}`;
  const mins = Math.ceil(diff / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `resets ${time} · in ${h ? `${h}h ${m}m` : `${m}m`}`;
}

export function useLimits(running = false) {
  const [limits, setLimits] = useState<LimitSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh(force = false) {
    setLoading(true);
    try {
      const res = await fetch(`/api/limits${force ? "?force=1" : ""}`, { cache: "no-store" });
      if (res.ok) setLimits((await res.json()) as LimitSnapshot);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  useEffect(() => {
    const onFocus = () => refresh().catch(() => {});
    // Fired when a run finishes. The server already refreshed the usage cache
    // while measuring this run's deltas, so a plain (cached) refresh picks up
    // the new numbers without forcing another request to Anthropic.
    const onRefresh = () => refresh().catch(() => {});
    window.addEventListener("focus", onFocus);
    window.addEventListener("fuse:limits-refresh", onRefresh);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("fuse:limits-refresh", onRefresh);
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => refresh().catch(() => {}), 60_000);
    return () => window.clearInterval(id);
  }, [running]);

  return { limits, loading, refresh };
}

function tone(value: number | undefined): string {
  if (value === undefined) return "bg-muted";
  if (value >= 90) return "bg-red-500";
  if (value >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

function width(value: number | undefined): string {
  if (value === undefined) return "0%";
  return `${Math.max(1, Math.min(100, value))}%`;
}

function windowTitle(label: string, win: LimitWindow | null): string {
  if (!win) return `${label}: unavailable`;
  return `${label}: ${formatPercent(win.usedPercent)} used · ${formatResetAt(win.resetsAt)}`;
}

function MiniBars({ provider }: { provider: ProviderLimits }) {
  const sessionPct = provider.session?.usedPercent;
  const weeklyPct = provider.weekly?.usedPercent;
  return (
    <div className="grid w-16 gap-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-subtle" title={windowTitle("5h", provider.session)}>
        <div className={`h-full rounded-full ${tone(sessionPct)}`} style={{ width: width(sessionPct) }} />
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-subtle" title={windowTitle("Weekly", provider.weekly)}>
        <div className={`h-full rounded-full ${tone(weeklyPct)}`} style={{ width: width(weeklyPct) }} />
      </div>
    </div>
  );
}

export function ProviderLimitRows({ provider }: { provider: ProviderLimits }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{providerLabel(provider.provider)}</span>
        {provider.planType && <span className="text-xs uppercase tracking-wide text-muted">{provider.planType}</span>}
      </div>
      {provider.error ? (
        <div className="rounded-xl border border-border p-2 text-xs text-muted">{provider.error}</div>
      ) : (
        <>
          <LimitRow label="5h" window={provider.session} />
          <LimitRow label="Weekly" window={provider.weekly} />
          {provider.scoped?.length ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {provider.scoped.map((item) => (
                <span key={item.label} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">
                  {item.label} {formatPercent(item.usedPercent)}
                </span>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function LimitRow({ label, window }: { label: string; window: LimitWindow | null }) {
  const pct = window?.usedPercent;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3 text-xs">
        <span className="text-muted">{label}</span>
        <span title={formatResetAt(window?.resetsAt)}>{window ? formatPercent(window.usedPercent) : "—"}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-subtle">
        <div className={`h-full rounded-full ${tone(pct)}`} style={{ width: width(pct) }} />
      </div>
    </div>
  );
}

export function LimitMeter({ limits, compact = false }: { limits: LimitSnapshot | null; compact?: boolean }) {
  if (!limits) return <span className="text-xs text-muted">Usage…</span>;
  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <MiniBars provider={limits.claude} />
        <MiniBars provider={limits.codex} />
      </div>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <ProviderLimitRows provider={limits.claude} />
      <ProviderLimitRows provider={limits.codex} />
    </div>
  );
}

export function NavLimitMeter() {
  useSyncExternalStore(subscribeRuns, runsVersion, runsVersion);
  const running = runningConvIds().length > 0;
  const { limits } = useLimits(running);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="rounded-xl border border-border px-2.5 py-2 transition hover:border-fg"
        aria-label="Usage limits"
        title="Usage limits"
      >
        <LimitMeter limits={limits} compact />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-80 rounded-2xl border border-border bg-bg p-4 text-sm shadow-xl">
          <LimitMeter limits={limits} />
        </div>
      )}
    </div>
  );
}

export function ComposerLimitWarning({ providers }: { providers: LimitProvider[] }) {
  const { limits } = useLimits(false);
  if (!limits || providers.length === 0) return null;
  const unique = Array.from(new Set(providers));
  const hot = unique
    .map((provider) => limits[provider])
    .find((item) => item.session && item.session.usedPercent >= 90);
  if (!hot?.session) return null;

  const otherName: LimitProvider = hot.provider === "claude" ? "codex" : "claude";
  const other = limits[otherName];
  const otherLeft = other.session ? Math.max(0, 100 - other.session.usedPercent) : null;

  return (
    <div className="mb-2 rounded-2xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
      {providerLabel(hot.provider)} 5h at {formatPercent(hot.session.usedPercent)}, {formatResetAt(hot.session.resetsAt)}.
      {otherLeft !== null
        ? ` ${providerLabel(otherName)} has ${formatPercent(otherLeft)} of its 5h left.`
        : ` ${providerLabel(otherName)} usage is unavailable.`}
    </div>
  );
}
