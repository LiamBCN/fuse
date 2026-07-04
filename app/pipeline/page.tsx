"use client";
import { useEffect, useRef, useState } from "react";
import { Fan, Hero, Label, MdIcon, Node, Pair, PlanCard, PlanIcon, PromptIcon, Spine } from "@/components/flow";

const STEP_MS = 700;

// Plan Mode stages: 0 task · 1 overlapped scan/drafts · 2 finalizer · 3 ready
const PLAN_STEPS = [0, 1, 2, 3];

export default function PipelinePage() {
  return (
    <div className="mx-auto h-full max-w-xl overflow-y-auto px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">How it works</h1>
      {/* <p className="mt-3 text-sm text-muted">
        In plain Chat (no folder), every mode just answers and the strongest model fuses the replies into one.
        Point Fuse at a folder and it switches to Plan Mode - pick the pipeline that fits.
      </p> */}

      <div className="mt-10">
        <PlanMode />
      </div>
    </div>
  );
}

/* ---------- Plan Mode ---------- */

type PlanVariant = "fast" | "relay" | "recon";

// Order: Normal first (the default), then Relay, then Recon.
const PLAN_VARIANTS: { id: PlanVariant; label: string; why: string }[] = [
  {
    id: "fast",
    label: "Normal",
    why: "Speed: two agents draft plans from your real code in parallel, then the strongest model fact-checks the load-bearing claims against the source and finalizes.",
  },
  {
    id: "relay",
    label: "Relay",
    why: "The classic hand-off, compressed: two agents draft from your real code, then one blind harden-and-finalize pass merges the stronger coverage without re-opening files. Lighter checking than Normal/Recon, fastest deep-reasoning pipeline.",
  },
  {
    id: "recon",
    label: "Recon",
    why: "Power: clarify, recon, and two grounded drafts start together; one finalizer resumes the recon session when available, fact-checks both drafts, and writes the verified plan. Maximum-confidence plan with much less waiting.",
  },
];

function PlanMode() {
  const [variant, setVariant] = useState<PlanVariant>("fast");
  const [step, setStep] = useState(-1);
  const timers = useRef<number[]>([]);

  function play() {
    timers.current.forEach(clearTimeout);
    setStep(0);
    timers.current = PLAN_STEPS.map((s, i) => window.setTimeout(() => setStep(s), i * STEP_MS));
    timers.current.push(window.setTimeout(() => setStep(-1), PLAN_STEPS.length * STEP_MS + 1600));
  }

  // Replay on first view and whenever the variant changes.
  useEffect(() => {
    const t = window.setTimeout(play, 400);
    return () => {
      clearTimeout(t);
      timers.current.forEach(clearTimeout);
    };
  }, [variant]);

  const lit = (i: number) => step === -1 || step >= i;
  const dim = (i: number) => step !== -1 && step < i;
  const active = PLAN_VARIANTS.find((v) => v.id === variant)!;

  return (
    <div>
      {/* <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-3xl font-semibold tracking-tight">Plan Mode</h2>
          </div>
          <p className="mt-1 text-sm text-muted">Ground every plan in your real code - draft, fact-check the load-bearing claims, then finalize.</p>
        </div>
      </div> */}

      {/* Variant tabs - compare the approaches */}
      <div className="mt-6 flex flex-wrap gap-2">
        {PLAN_VARIANTS.map((v) => (
          <button
            key={v.id}
            onClick={() => setVariant(v.id)}
            className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm transition ${
              variant === v.id ? "border-fg bg-fg text-bg" : "border-border text-muted hover:text-fg"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="mt-10 flex flex-col items-center">
        {variant === "fast" && <NormalFlow lit={lit} dim={dim} />}
        {variant === "relay" && <RelayFlow lit={lit} dim={dim} />}
        {variant === "recon" && <ReconFlow lit={lit} dim={dim} />}
      </div>

      <p className="mt-10 text-sm text-muted">{active.why}</p>
      <div className="mt-4 rounded-2xl border border-border bg-subtle p-4 text-sm text-muted">
        <span className="font-medium text-fg">Where Fuse fits:</span> it&apos;s the orchestrator - runs the
        CLIs in the right order with folder access so grounded stages read your real code, passes the brief
        and drafts between them, and writes the final{" "}
        <code className="rounded bg-bg px-1">plan.md</code> (listing each file&apos;s absolute path when a plan
        spans multiple docs).
      </div>
    </div>
  );
}

type FlowProps = { lit: (i: number) => boolean; dim: (i: number) => boolean };

// Normal: grounded drafts → one verify-and-finalize pass → md.
function NormalFlow({ lit, dim }: FlowProps) {
  return (
    <>
      <Node dim={dim(0)} lit={lit(0)} icon={<PromptIcon />} label="Describe the feature" />
      <Fan n={2} dir="down" on={lit(1) && !dim(1)} />
      <Pair dimmed={dim(1)} label="Draft · grounded, in parallel">
        <PlanCard lit={lit(1)} icon={<PlanIcon />} model="Claude" sub="Plan A" />
        <PlanCard lit={lit(1)} icon={<PlanIcon />} model="Codex" sub="Plan B" />
      </Pair>
      <Fan n={2} dir="up" on={lit(2) && !dim(2)} />
      <Hero dimmed={dim(2)} title="Verify & finalize" sub="strongest model fact-checks the load-bearing claims against the source, then writes the final plan" />
      <Spine on={lit(3) && !dim(3)} />
      <Node dim={dim(3)} lit={lit(3)} icon={<MdIcon />} label="plan.md - verified" />
    </>
  );
}

// Relay: grounded drafts → blind harden-and-finalize → md.
function RelayFlow({ lit, dim }: FlowProps) {
  return (
    <>
      <Node dim={dim(0)} lit={lit(0)} icon={<PromptIcon />} label="Describe the feature" />
      <Fan n={2} dir="down" on={lit(1) && !dim(1)} />
      <Pair dimmed={dim(1)} label="Draft · grounded, in parallel">
        <PlanCard lit={lit(1)} icon={<PlanIcon />} model="Claude" sub="Plan A" />
        <PlanCard lit={lit(1)} icon={<PlanIcon />} model="Codex" sub="Plan B" />
      </Pair>
      <Fan n={2} dir="up" on={lit(2) && !dim(2)} />
      <Hero dimmed={dim(2)} title="Harden & finalize" sub="strongest model merges the drafts blind, with no tools, into one implementation-ready plan" />
      <Spine on={lit(3) && !dim(3)} />
      <Node dim={dim(3)} lit={lit(3)} icon={<MdIcon />} label="plan.md" />
    </>
  );
}

// Recon: clarify ∥ recon brief ∥ grounded drafts → verify-and-finalize → md.
function ReconFlow({ lit, dim }: FlowProps) {
  return (
    <>
      <Node dim={dim(0)} lit={lit(0)} icon={<PromptIcon />} label="Describe the feature" />
      <Fan n={4} dir="down" on={lit(1) && !dim(1)} />
      <div className={`w-full transition-opacity duration-500 ${dim(1) ? "opacity-30" : "opacity-100"}`}>
        <Label>First wave · overlapped</Label>
        <div className="grid grid-cols-2 gap-3">
          <PlanCard lit={lit(1)} icon={<PlanIcon />} model="Clarify" sub="screens only true blockers" />
          <PlanCard lit={lit(1)} icon={<PlanIcon />} model="Recon" sub="briefs files and named surfaces" />
          <PlanCard lit={lit(1)} icon={<PlanIcon />} model="Claude" sub="drafts Plan A" />
          <PlanCard lit={lit(1)} icon={<PlanIcon />} model="Codex" sub="drafts Plan B" />
        </div>
      </div>
      <Fan n={4} dir="up" on={lit(2) && !dim(2)} />
      <Hero dimmed={dim(2)} title="Verify & finalize" sub="resumes recon when available, checks both drafts against the code, then writes one plan" />
      <Spine on={lit(3) && !dim(3)} />
      <Node dim={dim(3)} lit={lit(3)} icon={<MdIcon />} label="plan.md - verified" />
    </>
  );
}
