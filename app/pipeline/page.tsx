"use client";
import { useEffect, useRef, useState } from "react";
import { loadConfig, type FuseConfig } from "@/lib/settings";

// Stage indices for the run animation:
// 0 prompt · 1 fan-out · 2 agents · 3 fan-in · 4 fuse · 5 result
const STEPS = [0, 1, 2, 3, 4, 5];
const STEP_MS = 700;

// Plan Mode stages: 0 task · 1 two plans · 2 cross-review · 3 merge · 4 risk gate · 5 ready
const PLAN_STEPS = [0, 1, 2, 3, 4, 5];

export default function PipelinePage() {
  const [cfg, setCfg] = useState<FuseConfig | null>(null);
  const [step, setStep] = useState(-1); // -1 = static (everything shown)
  const timers = useRef<number[]>([]);

  function play() {
    timers.current.forEach(clearTimeout);
    timers.current = STEPS.map((s, i) => window.setTimeout(() => setStep(s), i * STEP_MS));
    timers.current.push(window.setTimeout(() => setStep(-1), STEPS.length * STEP_MS + 1600));
  }

  useEffect(() => {
    loadConfig().then(setCfg);
    const t = window.setTimeout(play, 350); // gentle auto-play once on load
    return () => {
      clearTimeout(t);
      timers.current.forEach(clearTimeout);
    };
  }, []);

  const proposers = cfg?.proposers ?? [];
  const n = Math.max(proposers.length, 1);
  const rounds = cfg?.rounds ?? 1;
  const refines = Math.max(0, rounds - 1); // extra refinement passes
  const lit = (i: number) => step === -1 || step >= i; // reached / static
  const dim = (i: number) => step !== -1 && step < i; // not yet reached

  return (
    <div className="mx-auto h-full max-w-xl overflow-y-auto px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">How it works</h1>

      <div className="mt-12 flex flex-col items-center">
        {/* Prompt */}
        <Node dim={dim(0)} lit={lit(0)} icon={<PromptIcon />} label="Prompt" />

        <Fan n={n} dir="down" on={lit(1) && !dim(1)} />

        {/* Agents */}
        <div className={`w-full transition-opacity duration-500 ${dim(2) ? "opacity-30" : "opacity-100"}`}>
          <Label>Agents · in parallel</Label>
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
            {(proposers.length ? proposers : [{ provider: "-", model: "add models" }]).map((p, i) => (
              <div
                key={i}
                className={`rounded-2xl border p-4 text-center transition-colors duration-300 ${
                  lit(2) ? "border-fg" : "border-border"
                }`}
              >
                <div className="truncate text-sm font-medium">{p.model}</div>
                <div className="mt-0.5 text-xs text-muted">{p.provider}</div>
              </div>
            ))}
          </div>
          {refines > 0 && (
            <div className="mt-3 flex items-center justify-center gap-2 rounded-full border border-dashed border-border px-4 py-1.5 text-xs text-muted">
              <RefineIcon />
              answers feed back to every agent · refine ×{refines}
            </div>
          )}
        </div>

        <Fan n={n} dir="up" on={lit(3) && !dim(3)} />

        {/* Fuse - the star */}
        <div className={`w-full transition-opacity duration-500 ${dim(4) ? "opacity-30" : "opacity-100"}`}>
          <div className="flex flex-col items-center gap-2 rounded-3xl bg-fg px-6 py-7 text-center text-bg shadow-lg">
            <FuseIcon />
            <div className="text-xl font-semibold">Fuse</div>
            <div className="text-sm opacity-80">merges every answer into one</div>
          </div>
        </div>

        <Spine on={lit(5) && !dim(5)} />

        {/* Result */}
        <Node dim={dim(5)} lit={lit(5)} icon={<ResultIcon />} label="Result" />
      </div>

      <p className="mt-12 text-center text-sm text-muted">
        Different models, different strengths - fusing keeps the best of each.
        {refines === 0 && " Turn on Advanced reasoning in chat to add a refinement round."}
      </p>

      <div className="my-16 border-t border-border" />

      <PlanMode />
    </div>
  );
}

/* ---------- Plan Mode demo (proposed) ---------- */

type PlanVariant = "converge" | "cross" | "relay";

const PLAN_VARIANTS: { id: PlanVariant; label: string; tag?: string; why: string }[] = [
  {
    id: "converge",
    label: "Diverge → Converge",
    tag: "recommended",
    why: "My pick. Independent drafts give diversity; an adversarial cross-critique surfaces flaws no single model catches; one strong model synthesizes a single coherent plan; then a structured risk gate loops only until no blocking risks remain (usually 0–1 extra passes). Best balance of breadth, rigor, and speed.",
  },
  {
    id: "cross",
    label: "A · Cross-review",
    why: "Both draft in parallel, each reviews the other once, then merge. Fast and diverse, but lighter on risk-hardening and final convergence.",
  },
  {
    id: "relay",
    label: "B · Relay",
    why: "Claude drafts → Codex hardens it (risks + best of Plan B) → Claude finalizes, comparing with its own draft and thinking harder. Deep and thorough, but sequential (slower) and more prone to anchoring on the first draft.",
  },
];

function PlanMode() {
  const [variant, setVariant] = useState<PlanVariant>("converge");
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
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-3xl font-semibold tracking-tight">Plan Mode</h2>
            <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted">proposed</span>
          </div>
          <p className="mt-1 text-sm text-muted">Harden a plan with two models before writing any code.</p>
        </div>
      </div>

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
            {v.tag && <StarIcon />}
            {v.label}
          </button>
        ))}
      </div>

      <div className="mt-10 flex flex-col items-center">
        {variant === "converge" && <ConvergeFlow lit={lit} dim={dim} />}
        {variant === "cross" && <CrossFlow lit={lit} dim={dim} />}
        {variant === "relay" && <RelayFlow lit={lit} dim={dim} />}
      </div>

      <p className="mt-10 text-sm text-muted">
        {active.tag && <span className="font-medium text-fg">Recommended - </span>}
        {active.why}
      </p>
      <div className="mt-4 rounded-2xl border border-border bg-subtle p-4 text-sm text-muted">
        <span className="font-medium text-fg">Where Fuse fits:</span> it&apos;s the orchestrator - runs the
        CLIs in the right order, passes plans between them, enforces the risk gate, and writes the final{" "}
        <code className="rounded bg-bg px-1">plan.md</code> (listing each file&apos;s absolute path when a plan
        spans multiple docs).
      </div>
    </div>
  );
}

type FlowProps = { lit: (i: number) => boolean; dim: (i: number) => boolean };

// My recommendation: diverge (parallel drafts) → adversarial cross-critique → synthesize → risk gate → md.
function ConvergeFlow({ lit, dim }: FlowProps) {
  return (
    <>
      <Node dim={dim(0)} lit={lit(0)} icon={<PromptIcon />} label="Describe the feature" />
      <Fan n={2} dir="down" on={lit(1) && !dim(1)} />
      <Pair dimmed={dim(1)} label="Draft · same prompt, in parallel">
        <PlanCard lit={lit(1)} icon={<PlanIcon />} model="Claude" sub="drafts Plan A" />
        <PlanCard lit={lit(1)} icon={<PlanIcon />} model="Codex" sub="drafts Plan B" />
      </Pair>
      <Crossover on={lit(2) && !dim(2)} />
      <Pair dimmed={dim(2)} label="Adversarial cross-critique · attack the other's plan">
        <PlanCard lit={lit(2)} icon={<ReviewIcon />} model="Claude" sub="finds risks in Plan B" />
        <PlanCard lit={lit(2)} icon={<ReviewIcon />} model="Codex" sub="finds risks in Plan A" />
      </Pair>
      <Fan n={2} dir="up" on={lit(3) && !dim(3)} />
      <Hero dimmed={dim(3)} title="Synthesize" sub="strongest model reconciles both into one plan" />
      <Spine on={lit(4) && !dim(4)} />
      <RiskGate lit={lit(4)} dimmed={dim(4)} />
      <Spine on={lit(5) && !dim(5)} />
      <Node dim={dim(5)} lit={lit(5)} icon={<MdIcon />} label="plan.md - ready" />
    </>
  );
}

// Option A: parallel draft → single cross-review → merge → md.
function CrossFlow({ lit, dim }: FlowProps) {
  return (
    <>
      <Node dim={dim(0)} lit={lit(0)} icon={<PromptIcon />} label="Describe the feature" />
      <Fan n={2} dir="down" on={lit(1) && !dim(1)} />
      <Pair dimmed={dim(1)} label="Draft · in parallel">
        <PlanCard lit={lit(1)} icon={<PlanIcon />} model="Claude" sub="drafts Plan A" />
        <PlanCard lit={lit(1)} icon={<PlanIcon />} model="Codex" sub="drafts Plan B" />
      </Pair>
      <Crossover on={lit(2) && !dim(2)} />
      <Pair dimmed={dim(2)} label="Cross-review · each reviews the other">
        <PlanCard lit={lit(2)} icon={<ReviewIcon />} model="Claude" sub="reviews Plan B" />
        <PlanCard lit={lit(2)} icon={<ReviewIcon />} model="Codex" sub="reviews Plan A" />
      </Pair>
      <Fan n={2} dir="up" on={lit(3) && !dim(3)} />
      <Hero dimmed={dim(3)} title="Merge" sub="keeps the best of both into one plan" />
      <Spine on={lit(4) && !dim(4)} />
      <Node dim={dim(4)} lit={lit(4)} icon={<MdIcon />} label="plan.md - ready" />
    </>
  );
}

// Option B: parallel draft → Codex hardens Claude's plan → Claude finalizes → risk gate → md.
function RelayFlow({ lit, dim }: FlowProps) {
  return (
    <>
      <Node dim={dim(0)} lit={lit(0)} icon={<PromptIcon />} label="Describe the feature" />
      <Fan n={2} dir="down" on={lit(1) && !dim(1)} />
      <Pair dimmed={dim(1)} label="Draft · in parallel">
        <PlanCard lit={lit(1)} icon={<PlanIcon />} model="Claude" sub="Plan A" />
        <PlanCard lit={lit(1)} icon={<PlanIcon />} model="Codex" sub="Plan B" />
      </Pair>
      <Fan n={2} dir="up" on={lit(2) && !dim(2)} />
      <StepCard lit={lit(2)} dimmed={dim(2)} icon={<ReviewIcon />} title="Codex hardens Plan A" sub="risk-checks it, folds in the best of Plan B" />
      <Spine on={lit(3) && !dim(3)} />
      <StepCard lit={lit(3)} dimmed={dim(3)} icon={<ReviewIcon />} title="Claude finalizes" sub="compares with its own Plan A, thinks harder, removes risks" />
      <Spine on={lit(4) && !dim(4)} />
      <RiskGate lit={lit(4)} dimmed={dim(4)} />
      <Spine on={lit(5) && !dim(5)} />
      <Node dim={dim(5)} lit={lit(5)} icon={<MdIcon />} label="plan.md - ready" />
    </>
  );
}

function Pair({ dimmed, label, children }: { dimmed: boolean; label: string; children: React.ReactNode }) {
  return (
    <div className={`w-full transition-opacity duration-500 ${dimmed ? "opacity-30" : "opacity-100"}`}>
      <Label>{label}</Label>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </div>
  );
}

function Hero({ dimmed, title, sub }: { dimmed: boolean; title: string; sub: string }) {
  return (
    <div className={`w-full transition-opacity duration-500 ${dimmed ? "opacity-30" : "opacity-100"}`}>
      <div className="flex flex-col items-center gap-2 rounded-3xl bg-fg px-6 py-7 text-center text-bg shadow-lg">
        <FuseIcon />
        <div className="text-xl font-semibold">{title}</div>
        <div className="text-sm opacity-80">{sub}</div>
      </div>
    </div>
  );
}

function StepCard({ lit, dimmed, title, sub, icon }: { lit: boolean; dimmed: boolean; title: string; sub: string; icon: React.ReactNode }) {
  return (
    <div className={`w-full transition-opacity duration-500 ${dimmed ? "opacity-30" : "opacity-100"}`}>
      <div className={`flex flex-col items-center gap-1 rounded-3xl border p-5 text-center transition-colors ${lit ? "border-fg" : "border-border"}`}>
        {icon}
        <div className="text-base font-semibold">{title}</div>
        <div className="text-sm text-muted">{sub}</div>
      </div>
    </div>
  );
}

function RiskGate({ lit, dimmed }: { lit: boolean; dimmed: boolean }) {
  return (
    <div className={`w-full transition-opacity duration-500 ${dimmed ? "opacity-30" : "opacity-100"}`}>
      <div className={`flex flex-col items-center gap-1 rounded-3xl border p-5 text-center transition-colors ${lit ? "border-fg" : "border-border"}`}>
        <ShieldIcon />
        <div className="text-base font-semibold">Ready to implement?</div>
        <div className="text-sm text-muted">structured risk check → {"{ risks, ready }"}</div>
      </div>
      <div className="mt-3 flex items-center justify-center gap-2 rounded-full border border-dashed border-border px-4 py-1.5 text-center text-xs text-muted">
        <RefineIcon />
        blocking risks → one more pass (max 2)
      </div>
    </div>
  );
}

function PlanCard({
  lit,
  model,
  sub,
  icon,
}: {
  lit: boolean;
  model: string;
  sub: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className={`rounded-2xl border p-4 text-center transition-colors duration-300 ${lit ? "border-fg" : "border-border"}`}>
      <div className="flex items-center justify-center gap-1.5 text-sm font-medium">
        {icon}
        {model}
      </div>
      <div className="mt-0.5 text-xs text-muted">{sub}</div>
    </div>
  );
}

// Two crossing connectors: Plan A → the other model, Plan B → the other model.
function Crossover({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 100 10" preserveAspectRatio="none" className={`my-2 h-12 w-full transition-colors ${on ? "text-fg" : "text-border"}`}>
      <line x1={25} y1={0} x2={75} y2={10} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" className={on ? "fan-flow" : ""} />
      <line x1={75} y1={0} x2={25} y2={10} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" className={on ? "fan-flow" : ""} />
    </svg>
  );
}

/* ---------- pieces ---------- */

function Node({ icon, label, lit, dim }: { icon: React.ReactNode; label: string; lit: boolean; dim: boolean }) {
  return (
    <div
      className={`flex items-center gap-3 rounded-full border px-6 py-3.5 transition-all duration-500 ${
        dim ? "opacity-30" : "opacity-100"
      } ${lit ? "border-fg" : "border-border"}`}
    >
      {icon}
      <span className="text-base font-medium">{label}</span>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 text-center text-xs uppercase tracking-wide text-muted">{children}</div>;
}

// Manifold connector: apex (center) fanning to n points, constant stroke width.
function Fan({ n, dir, on }: { n: number; dir: "down" | "up"; on: boolean }) {
  const xs = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * 100);
  return (
    <svg viewBox="0 0 100 10" preserveAspectRatio="none" className={`my-2 h-12 w-full transition-colors ${on ? "text-fg" : "text-border"}`}>
      {xs.map((x, i) => {
        const p = dir === "down" ? { x1: 50, y1: 0, x2: x, y2: 10 } : { x1: x, y1: 0, x2: 50, y2: 10 };
        return <line key={i} {...p} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" className={on ? "fan-flow" : ""} />;
      })}
    </svg>
  );
}

function Spine({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 100 10" preserveAspectRatio="none" className={`my-2 h-12 w-full transition-colors ${on ? "text-fg" : "text-border"}`}>
      <line x1={50} y1={0} x2={50} y2={10} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" className={on ? "fan-flow" : ""} />
    </svg>
  );
}

/* ---------- icons (monochrome, inherit color) ---------- */

const ico = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function PromptIcon() {
  return (
    <svg {...ico}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function FuseIcon() {
  return (
    <svg {...ico} width={26} height={26}>
      <path d="M6 3v4a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v4" />
      <path d="M18 3v4a4 4 0 0 1-4 4h-4a4 4 0 0 0-4 4v4" />
    </svg>
  );
}
function ResultIcon() {
  return (
    <svg {...ico}>
      <path d="M12 3l2.2 5 5.3.4-4 3.5 1.2 5.2L12 19l-4.7 2.6 1.2-5.2-4-3.5 5.3-.4z" />
    </svg>
  );
}
function RefineIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}
function PlanIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1z" />
      <path d="M8 4H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
      <path d="M8 11h8M8 15h5" />
    </svg>
  );
}
function ReviewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg {...ico}>
      <path d="M12 3l7 3v5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
function StarIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 3l2.2 5 5.3.4-4 3.5 1.2 5.2L12 19l-4.7 2.6 1.2-5.2-4-3.5 5.3-.4z" />
    </svg>
  );
}
function MdIcon() {
  return (
    <svg {...ico}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </svg>
  );
}
