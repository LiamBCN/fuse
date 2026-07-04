import type { Mode } from "@/lib/types";

const LABELS: Record<Mode, string> = {
  fast: "Normal",
  relay: "Relay",
  recon: "Recon",
};

const STYLES: Record<Mode, string> = {
  fast: "border-orange-500/50 text-orange-500",
  relay: "border-sky-500/50 text-sky-500",
  recon: "border-fg/50 text-fg",
};

export default function ModeBadge({ mode, className = "" }: { mode?: Mode; className?: string }) {
  const m = mode ?? "fast";
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STYLES[m]} ${className}`}>
      {LABELS[m]}
    </span>
  );
}
