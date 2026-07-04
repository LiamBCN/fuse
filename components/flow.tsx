import type { ReactNode } from "react";

export function Pair({ dimmed, label, children }: { dimmed: boolean; label: string; children: ReactNode }) {
  return (
    <div className={`w-full transition-opacity duration-500 ${dimmed ? "opacity-30" : "opacity-100"}`}>
      <Label>{label}</Label>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </div>
  );
}

export function Hero({ dimmed, title, sub }: { dimmed: boolean; title: string; sub: string }) {
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

export function StepCard({
  lit,
  dimmed,
  title,
  sub,
  icon,
}: {
  lit: boolean;
  dimmed: boolean;
  title: string;
  sub: string;
  icon: ReactNode;
}) {
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

export function PlanCard({
  lit,
  model,
  sub,
  icon,
}: {
  lit: boolean;
  model: string;
  sub: string;
  icon?: ReactNode;
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

export function Node({ icon, label, lit, dim }: { icon: ReactNode; label: string; lit: boolean; dim: boolean }) {
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

export function Label({ children }: { children: ReactNode }) {
  return <div className="mb-3 text-center text-xs uppercase tracking-wide text-muted">{children}</div>;
}

// Manifold connector: apex (center) fanning to n points, constant stroke width.
export function Fan({ n, dir, on }: { n: number; dir: "down" | "up"; on: boolean }) {
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

export function Spine({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 100 10" preserveAspectRatio="none" className={`my-2 h-12 w-full transition-colors ${on ? "text-fg" : "text-border"}`}>
      <line x1={50} y1={0} x2={50} y2={10} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" className={on ? "fan-flow" : ""} />
    </svg>
  );
}

const ico = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function PromptIcon() {
  return (
    <svg {...ico}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function FuseIcon() {
  return (
    <svg {...ico} width={26} height={26}>
      <path d="M6 3v4a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v4" />
      <path d="M18 3v4a4 4 0 0 1-4 4h-4a4 4 0 0 0-4 4v4" />
    </svg>
  );
}

export function ResultIcon() {
  return (
    <svg {...ico}>
      <path d="M12 3l2.2 5 5.3.4-4 3.5 1.2 5.2L12 19l-4.7 2.6 1.2-5.2-4-3.5 5.3-.4z" />
    </svg>
  );
}

export function RefineIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

export function PlanIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1z" />
      <path d="M8 4H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
      <path d="M8 11h8M8 15h5" />
    </svg>
  );
}

export function ShieldIcon() {
  return (
    <svg {...ico}>
      <path d="M12 3l7 3v5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function StarIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 3l2.2 5 5.3.4-4 3.5 1.2 5.2L12 19l-4.7 2.6 1.2-5.2-4-3.5 5.3-.4z" />
    </svg>
  );
}

export function MdIcon() {
  return (
    <svg {...ico}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </svg>
  );
}
