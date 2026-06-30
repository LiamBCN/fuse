"use client";
import { useCallback, useEffect, useState } from "react";
import Logo from "./Logo";

interface CliStatus {
  ok: boolean;
  path: string | null;
  version?: string;
  error?: string;
}
interface SetupData {
  claude: CliStatus;
  codex: CliStatus;
  error?: string;
}

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<"intro" | "checks">("intro");
  const [data, setData] = useState<SetupData | null>(null);
  const [checking, setChecking] = useState(true);
  const [notif, setNotif] = useState<NotificationPermission | "unsupported">("default");
  const [mic, setMic] = useState<"unknown" | "checking" | "granted" | "denied">("unknown");

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const r = await fetch("/api/setup", { cache: "no-store" });
      setData(await r.json());
    } catch {
      setData({
        claude: { ok: false, path: null, error: "Could not reach the Fuse server." },
        codex: { ok: false, path: null },
      });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    check();
    setNotif(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  }, [check]);

  const enableNotifications = async () => {
    if (typeof Notification === "undefined") return;
    try {
      setNotif(await Notification.requestPermission());
    } catch {}
  };

  const enableMic = async () => {
    setMic("checking");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMic("granted");
    } catch {
      setMic("denied");
    }
  };

  const claudeOk = !!data?.claude.ok;
  const ready = claudeOk; // hard requirement: the aggregator runs through the Claude CLI

  const finish = () => {
    try {
      localStorage.setItem("fuse.setupComplete.v1", "1");
    } catch {}
    onDone();
  };

  // Step 1 - big, centered splash.
  if (step === "intro") {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center px-6 text-center">
        <Logo className="h-24 w-24" />
        <h1
          className="mt-8 bg-gradient-to-r from-red-600 to-amber-500 bg-clip-text font-bold tracking-tight text-transparent dark:from-red-500 dark:to-amber-400"
          style={{ fontSize: "5.5rem", lineHeight: 1.05 }}
        >
          Fuse
        </h1>
        <p className="mt-5 max-w-md text-xl text-muted">
          Ask once. Multiple agents. One fused answer - powered by the AI CLIs on your Mac.
        </p>
        <button
          onClick={() => setStep("checks")}
          className="mt-12 rounded-full bg-fg px-8 py-3.5 text-lg font-medium text-bg transition hover:opacity-90"
        >
          Get started
        </button>
      </div>
    );
  }

  // Step 2 - readiness checks.
  return (
    <div className="flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-xl px-6 py-12">
        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight">Quick setup</h1>
          <p className="mt-2 text-muted">Let&apos;s make sure everything&apos;s ready before you start.</p>
        </div>

        {/* Required */}
        <SectionLabel>Required</SectionLabel>
        <CheckRow
          title="Claude CLI"
          checking={checking}
          status={data?.claude}
          okText={data?.claude.version}
          hint="Install Claude Code, then run `claude` once in a terminal to sign in. Custom path? Set FUSE_CLAUDE_BIN to it and re-check."
        />

        {/* Recommended */}
        <SectionLabel>Recommended</SectionLabel>
        <CheckRow
          title="Codex CLI"
          checking={checking}
          status={data?.codex}
          okText={data?.codex.version}
          optional
          hint="Used as a second agent. Install Codex and run `codex` once to sign in (or set FUSE_CODEX_BIN). Fuse still works without it - that agent is just skipped."
        />

        {/* Permissions */}
        <SectionLabel>Permissions</SectionLabel>
        <div className="space-y-2">
          <PermissionRow
            title="Notifications"
            desc="Get notified when a long answer or plan finishes."
            state={
              notif === "granted" ? "on" : notif === "denied" || notif === "unsupported" ? "off" : "idle"
            }
            onEnable={enableNotifications}
            note={notif === "denied" ? "Blocked - enable Fuse in System Settings › Notifications." : undefined}
          />
          <PermissionRow
            title="Microphone"
            desc="Optional - for voice input."
            state={mic === "granted" ? "on" : mic === "denied" ? "off" : mic === "checking" ? "idle" : "idle"}
            onEnable={enableMic}
            note={mic === "denied" ? "Blocked - enable Fuse in System Settings › Microphone." : undefined}
          />
        </div>

        {/* Status + actions */}
        {!checking && !ready && (
          <div className="mt-6 rounded-2xl border border-red-500/40 bg-red-500/5 p-4 text-sm">
            <span className="font-semibold text-red-500">Not ready yet.</span>{" "}
            <span className="text-muted">
              The Claude CLI is required to use Fuse. Install &amp; sign in, then re-check.
            </span>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            onClick={check}
            disabled={checking}
            className="rounded-full border border-border px-5 py-2.5 font-medium text-muted transition hover:border-fg hover:text-fg disabled:opacity-50"
          >
            {checking ? "Checking…" : "Re-check"}
          </button>
          <button
            onClick={finish}
            disabled={!ready}
            className="rounded-full bg-fg px-6 py-2.5 font-medium text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Start using Fuse
          </button>
        </div>

        {!ready && !checking && (
          <div className="mt-4 text-center">
            <button onClick={finish} className="text-xs text-muted underline transition hover:text-fg">
              Continue anyway (not recommended)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 mt-8 text-xs font-semibold uppercase tracking-wide text-muted">{children}</div>;
}

function StatusDot({ state }: { state: "ok" | "fail" | "checking" | "warn" }) {
  if (state === "checking")
    return <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-transparent" />;
  const cls =
    state === "ok" ? "bg-green-500" : state === "warn" ? "bg-amber-500" : "bg-red-500";
  return (
    <span className={`flex h-5 w-5 items-center justify-center rounded-full text-bg ${cls}`}>
      {state === "ok" ? <CheckIcon /> : <span className="text-xs font-bold">!</span>}
    </span>
  );
}

function CheckRow({
  title,
  status,
  checking,
  okText,
  hint,
  optional,
}: {
  title: string;
  status?: CliStatus;
  checking: boolean;
  okText?: string;
  hint: string;
  optional?: boolean;
}) {
  const state: "ok" | "fail" | "checking" | "warn" = checking
    ? "checking"
    : status?.ok
      ? "ok"
      : optional
        ? "warn"
        : "fail";
  return (
    <div className="rounded-2xl border border-border bg-subtle p-4">
      <div className="flex items-center gap-3">
        <StatusDot state={state} />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{title}</div>
          <div className="truncate text-sm text-muted">
            {checking
              ? "Checking…"
              : status?.ok
                ? okText || status.path || "Found"
                : status?.path
                  ? `Found but won't run: ${status.error || "error"}`
                  : "Not found"}
          </div>
        </div>
      </div>
      {!checking && !status?.ok && <p className="mt-3 text-sm text-muted">{hint}</p>}
    </div>
  );
}

function PermissionRow({
  title,
  desc,
  state,
  onEnable,
  note,
}: {
  title: string;
  desc: string;
  state: "on" | "off" | "idle";
  onEnable: () => void;
  note?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-subtle p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{title}</div>
          <div className="text-sm text-muted">{note || desc}</div>
        </div>
        {state === "on" ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-green-500">
            <CheckIcon /> Enabled
          </span>
        ) : (
          <button
            onClick={onEnable}
            className="shrink-0 rounded-full border border-border px-4 py-2 text-sm font-medium transition hover:border-fg"
          >
            Enable
          </button>
        )}
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
