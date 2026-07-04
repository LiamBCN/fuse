"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Markdown from "@/components/Markdown";
import { Fan, MdIcon, Node, Pair, PlanIcon, PromptIcon, Spine } from "@/components/flow";
import type { Mode, StageInfo, StageStatus } from "@/lib/types";

const fmtChars = (n?: number) => {
  if (!n) return "";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k chars` : `${n} chars`;
};

function isStarted(stage?: StageInfo): boolean {
  return !!stage && (stage.status === "running" || stage.status === "done" || stage.status === "error");
}

function isDim(stage?: StageInfo): boolean {
  return !isStarted(stage);
}

function statusLabel(status: StageStatus): string {
  if (status === "running") return "Running";
  if (status === "done") return "Done";
  if (status === "error") return "Error";
  if (status === "skipped") return "Skipped";
  return "Pending";
}

function StatusGlyph({ status }: { status: StageStatus }) {
  if (status === "running") {
    return <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />;
  }
  if (status === "done") return <CheckIcon />;
  if (status === "error") return <AlertIcon />;
  return <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-current opacity-60" />;
}

function StageBody({ stage }: { stage: StageInfo }) {
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [stage.tail, stage.status]);

  if (stage.status === "running") {
    return stage.tail ? (
      <pre ref={preRef} className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-bg p-3 font-mono text-xs leading-relaxed text-fg">
        {stage.tail}
      </pre>
    ) : (
      <div className="rounded-xl bg-bg p-3 text-sm text-muted">{fmtChars(stage.chars) || "Working..."}</div>
    );
  }

  if (stage.error && !stage.output) {
    return <div className="rounded-xl bg-bg p-3 text-sm text-red-500">{stage.error}</div>;
  }

  if (stage.output) {
    return (
      <div className="max-h-[28rem] overflow-auto rounded-xl bg-bg p-4 text-fg">
        <Markdown>{stage.output}</Markdown>
      </div>
    );
  }

  if (stage.status === "skipped") return <div className="rounded-xl bg-bg p-3 text-sm text-muted">Skipped</div>;
  return <div className="rounded-xl bg-bg p-3 text-sm text-muted">Waiting...</div>;
}

function StageCard({
  stage,
  icon,
  hero = false,
  open,
  onToggle,
}: {
  stage?: StageInfo;
  icon: ReactNode;
  hero?: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const fallback: StageInfo = {
    key: "pending",
    title: "Pending",
    provider: "",
    model: "",
    status: "pending",
  };
  const s = stage ?? fallback;
  const dimmed = isDim(stage);
  const failed = s.status === "error";
  const lit = isStarted(stage);
  const shell = hero
    ? `${dimmed ? "opacity-30" : "opacity-100"}`
    : `${dimmed ? "opacity-30" : "opacity-100"}`;
  const face = hero
    ? `bg-fg text-bg ${failed ? "ring-2 ring-red-500" : ""}`
    : `border ${failed ? "border-red-500/60" : lit ? "border-fg" : "border-border"} bg-bg text-fg`;

  return (
    <div className={`w-full transition-opacity duration-500 ${shell}`}>
      <button
        type="button"
        onClick={onToggle}
        className={`w-full rounded-3xl p-5 text-left transition ${face}`}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0">{icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base font-semibold">{s.title}</span>
            <span className={hero ? "mt-1 block text-sm opacity-80" : "mt-1 block text-sm text-muted"}>
              {s.provider}/{s.model}
            </span>
          </span>
          <span className={`mt-0.5 inline-flex shrink-0 items-center gap-1.5 text-xs ${failed ? "text-red-500" : ""}`}>
            <StatusGlyph status={s.status} />
            {statusLabel(s.status)}
          </span>
        </div>
        <div className={hero ? "mt-3 text-xs opacity-80" : "mt-3 text-xs text-muted"}>
          {fmtChars(s.chars) || (s.status === "running" ? "Streaming..." : "No stream yet")}
        </div>
      </button>
      {open && (
        <div className={`mt-2 rounded-2xl border p-3 ${failed ? "border-red-500/40" : "border-border"} bg-subtle`}>
          <StageBody stage={s} />
        </div>
      )}
    </div>
  );
}

function LiveRunView({ mode, stages, elapsed }: { mode: Mode; stages: StageInfo[]; elapsed: string }) {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const byKey = useMemo(() => new Map(stages.map((s) => [s.key, s])), [stages]);
  const stage = (key: string) => byKey.get(key);
  const modeLabel = mode === "recon" ? "Recon" : mode === "relay" ? "Relay" : "Normal";
  const isOpen = (s?: StageInfo) => {
    if (!s) return false;
    if (Object.prototype.hasOwnProperty.call(touched, s.key)) return touched[s.key];
    return s.status === "running";
  };
  const toggle = (s?: StageInfo) => {
    if (!s) return;
    setTouched((prev) => ({ ...prev, [s.key]: !isOpen(s) }));
  };

  const draftA = stage("draftA");
  const draftB = stage("draftB");
  const finalize = stage("finalize");
  const reconFirstWaveStarted =
    isStarted(stage("clarify")) || isStarted(stage("recon")) || isStarted(draftA) || isStarted(draftB);

  return (
    <div className="mt-4 rounded-2xl border border-border bg-subtle px-4 py-5">
      <div className="mb-4 flex items-center justify-between gap-3 text-xs text-muted">
        <span>{modeLabel} run</span>
        <span>{elapsed}</span>
      </div>

      <div className="flex flex-col items-center">
        <Node dim={false} lit icon={<PromptIcon />} label="Prompt" />

        {mode === "recon" ? (
          <>
            <Fan n={4} dir="down" on={reconFirstWaveStarted} />
            <div className={`grid w-full grid-cols-1 gap-3 transition-opacity duration-500 sm:grid-cols-2 ${reconFirstWaveStarted ? "opacity-100" : "opacity-30"}`}>
              <StageCard
                stage={stage("clarify")}
                icon={<PlanIcon />}
                open={isOpen(stage("clarify"))}
                onToggle={() => toggle(stage("clarify"))}
              />
              <StageCard
                stage={stage("recon")}
                icon={<PlanIcon />}
                open={isOpen(stage("recon"))}
                onToggle={() => toggle(stage("recon"))}
              />
              <StageCard stage={draftA} icon={<PlanIcon />} open={isOpen(draftA)} onToggle={() => toggle(draftA)} />
              <StageCard stage={draftB} icon={<PlanIcon />} open={isOpen(draftB)} onToggle={() => toggle(draftB)} />
            </div>
            <Fan n={4} dir="up" on={isStarted(finalize)} />
            <StageCard
              stage={finalize}
              icon={<PlanIcon />}
              hero
              open={isOpen(finalize)}
              onToggle={() => toggle(finalize)}
            />
            <Spine on={isStarted(finalize) && finalize?.status !== "running"} />
            <Node dim={!isStarted(finalize)} lit={finalize?.status === "done"} icon={<MdIcon />} label="plan.md" />
          </>
        ) : (
          <>
            <Fan n={2} dir="down" on={isStarted(draftA) || isStarted(draftB)} />
            <Pair dimmed={isDim(draftA) && isDim(draftB)} label="Drafts">
              <StageCard stage={draftA} icon={<PlanIcon />} open={isOpen(draftA)} onToggle={() => toggle(draftA)} />
              <StageCard stage={draftB} icon={<PlanIcon />} open={isOpen(draftB)} onToggle={() => toggle(draftB)} />
            </Pair>
            <Fan n={2} dir="up" on={isStarted(finalize)} />
            <StageCard
              stage={finalize}
              icon={<PlanIcon />}
              hero
              open={isOpen(finalize)}
              onToggle={() => toggle(finalize)}
            />
            <Spine on={isStarted(finalize) && finalize?.status !== "running"} />
            <Node dim={!isStarted(finalize)} lit={finalize?.status === "done"} icon={<MdIcon />} label="plan.md" />
          </>
        )}
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 17h.01" />
    </svg>
  );
}

export default memo(LiveRunView);
