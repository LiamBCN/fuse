"use client";
import { useEffect, useRef, useState } from "react";
import { loadConfig, type FuseConfig } from "@/lib/settings";

// Stage indices for the run animation:
// 0 prompt · 1 fan-out · 2 agents · 3 fan-in · 4 fuse · 5 result
const STEPS = [0, 1, 2, 3, 4, 5];
const STEP_MS = 700;

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
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">How it works</h1>
        <button
          onClick={play}
          className="flex items-center gap-2 rounded-full border border-border px-5 py-2.5 font-medium transition hover:bg-subtle"
        >
          <PlayIcon /> Run
        </button>
      </div>

      <div className="mt-12 flex flex-col items-center">
        {/* Prompt */}
        <Node dim={dim(0)} lit={lit(0)} icon={<PromptIcon />} label="Prompt" />

        <Fan n={n} dir="down" on={lit(1) && !dim(1)} />

        {/* Agents */}
        <div className={`w-full transition-opacity duration-500 ${dim(2) ? "opacity-30" : "opacity-100"}`}>
          <Label>Agents · in parallel</Label>
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
            {(proposers.length ? proposers : [{ provider: "—", model: "add models" }]).map((p, i) => (
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

        {/* Fuse — the star */}
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
        Different models, different strengths — fusing keeps the best of each.
        {refines === 0 && " Turn on Advanced reasoning in chat to add a refinement round."}
      </p>
    </div>
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
function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
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
