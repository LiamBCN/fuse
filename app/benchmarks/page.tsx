"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bar,
  BarChart,
  Cell,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatResetAt } from "@/components/LimitMeter";
import Markdown from "@/components/Markdown";
import ModeBadge from "@/components/ModeBadge";
import { formatPercent, totalSessionDelta } from "@/lib/limit-format";
import { PROVIDERS } from "@/lib/models";
import { loadConfig, saveConfig, type FuseConfig } from "@/lib/settings";
import {
  BENCH_CRITERIA,
  BENCH_CRITERION_LABELS,
  type BenchRun,
  type BenchRunStatus,
  type BenchRunSummary,
  type BenchSummaryRow,
  type ContenderResult,
  type ContenderSpec,
  type ContenderStatus,
  type JudgePassStatus,
  type ScoreSource,
  type VerifierResult,
} from "@/lib/bench-types";
import type { BenchTask, ChecklistAxis, ChecklistItem } from "@/lib/bench-tasks";
import type { LimitProvider, LimitSnapshot, Mode, ModelRef, StageKey } from "@/lib/types";

const MODES: Mode[] = ["fast", "relay", "recon"];
const DEFAULT_JUDGE: ModelRef = { provider: "claude-cli", model: "claude-opus-4-8" };
const DEFAULT_SECOND_JUDGE: ModelRef = { provider: "codex-cli", model: "default" };
const CHECKLIST_AXES: ChecklistAxis[] = ["grounding", "coverage", "actionability", "testing", "scope"];

const STAGE_LABELS: Record<StageKey, string> = {
  clarify: "Clarify",
  recon: "Recon",
  draftA: "Draft A",
  draftB: "Draft B",
  harden: "Harden",
  verify: "Verify",
  synthesize: "Synthesize",
  finalize: "Finalize",
};

const fmtNum = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString());
const fmtScore = (n: number | undefined) => (n === undefined ? "—" : n.toFixed(1));
const fmtPct = (n: number | undefined) => (n === undefined ? "—" : `${n.toFixed(1)}%`);
const fmtLimitPct = (n: number | undefined) => (n === undefined || n === 0 ? "—" : `≈${formatPercent(n)}`);
const isPercentSource = (source?: ScoreSource) => source === "checklist" || source === "verifier";
const fmtRunScore = (n: number | undefined, source?: ScoreSource) =>
  isPercentSource(source) ? fmtPct(n) : fmtScore(n);
const DEFAULT_EXECUTOR: ModelRef = { provider: "claude-cli", model: "claude-sonnet-5" };

// Recommended default setup: relay + recon vs solo Fable 5, judged by a
// dual-family panel that excludes the modes' own finalizer (Opus) and the
// Fable contender, so neither judge grades its own work.
const DEFAULT_BENCH_TASK_ID = "migma-author-location-fields";
const FABLE_SOLO: ModelRef = { provider: "claude-cli", model: "claude-fable-5" };
const RECOMMENDED_MODES: Mode[] = ["relay", "recon"];
const RECOMMENDED_JUDGES: ModelRef[] = [
  { provider: "codex-cli", model: "gpt-5.5" },
  { provider: "claude-cli", model: "claude-sonnet-5" },
];
const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

interface SnapshotStatus {
  ready: boolean;
  path?: string;
  commit?: string;
  repos?: { path: string; commit: string }[];
  error?: string;
}

interface WorkdirCheck {
  warning?: string;
  litter?: string[];
}

function fmtMs(ms: number | undefined): string {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function isLive(status: BenchRunStatus) {
  return status === "running" || status === "judging";
}

function modelLabel(model: ModelRef) {
  return `${model.provider}/${model.model}`;
}

function resultLabel(result: ContenderResult): string {
  const spec = result.spec;
  const base =
    spec.kind === "solo"
      ? `${modelLabel(spec.model)} · solo`
      : `${spec.mode} · ${spec.proposers.map((p) => p.model).join(" + ")} → ${spec.aggregator.model}`;
  return result.rep > 1 ? `${base} · rep ${result.rep}` : base;
}

function statusLabel(status: BenchRunStatus | ContenderStatus): string {
  if (status === "done") return "Done";
  if (status === "running") return "Running";
  if (status === "judging") return "Judging";
  if (status === "pending") return "Pending";
  if (status === "clarified") return "Clarified";
  if (status === "rateLimited") return "Rate limited";
  if (status === "stopped") return "Stopped";
  return "Error";
}

function StatusChip({ status }: { status: BenchRunStatus | ContenderStatus }) {
  const live = status === "running" || status === "judging";
  const tone =
    status === "done"
      ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
      : status === "error" || status === "clarified" || status === "rateLimited"
        ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
        : status === "stopped"
          ? "border-muted text-muted"
          : "border-fg/40 text-fg";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${tone}`}>
      {live && <span className="h-2 w-2 animate-pulse rounded-full bg-current" />}
      {statusLabel(status)}
    </span>
  );
}

function ResolvedChip({ verifier }: { verifier: VerifierResult }) {
  if (verifier.error) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full border border-amber-500/50 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
        verifier error
      </span>
    );
  }
  const tone = verifier.resolved
    ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
    : "border-rose-500/40 text-rose-600 dark:text-rose-400";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${tone}`}>
      {verifier.resolved ? "✓ resolved" : "✗ unresolved"} · {verifier.hardPassed}/{verifier.hardTotal}
    </span>
  );
}

function JudgePassChip({ status }: { status: JudgePassStatus }) {
  const live = status === "running";
  const tone =
    status === "done"
      ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
      : status === "error"
        ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
        : status === "stopped"
          ? "border-muted text-muted"
          : status === "running"
            ? "border-fg/40 text-fg"
            : "border-border text-muted";
  const label = status === "running" ? "Judging" : status === "pending" ? "Queued" : statusLabel(status);
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${tone}`}>
      {live && <span className="h-2 w-2 animate-pulse rounded-full bg-current" />}
      {label}
    </span>
  );
}

function SharedBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-sky-500/40 px-2 py-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
      from git
    </span>
  );
}

function PublishedBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-emerald-500/40 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
      published
    </span>
  );
}

// Effective display status for a judge pass, tolerating runs persisted before
// the progress fields existed (derive from scores/error/run liveness).
function passDisplayStatus(run: BenchRun, pass: BenchRun["judgePasses"][number]): JudgePassStatus {
  if (pass.status) return pass.status;
  if (pass.error) return "error";
  if (pass.scores.length) return "done";
  return isLive(run.status) ? "running" : "stopped";
}

// Client mirror of the server judge-call math for the run-detail header.
function judgeProgress(run: BenchRun): { callsDone: number; callsTotal: number; passesDone: number; passesTotal: number } {
  const passes = run.judgePasses;
  const doneResultCount = run.results.filter((r) => r.status === "done" && !!r.final?.trim()).length;
  const legacyChecklistPer = run.config.checklist?.length ? doneResultCount : 0;
  const judgeCount = run.config.judges?.length ? run.config.judges.length : run.config.judge ? 1 : 1;
  const passesTotal = Math.max(passes.length, run.config.judgePasses * judgeCount);
  let callsDone = 0;
  let callsTotal = 0;
  let passesDone = 0;
  for (const pass of passes) {
    const checklistTotal = pass.checklistTotal ?? legacyChecklistPer;
    callsTotal += 1 + checklistTotal;
    if (pass.scores.length > 0 || pass.status === "done") callsDone += 1;
    callsDone += pass.checklistDone ?? pass.scores.filter((s) => typeof s.checklistScore === "number").length;
    const settled = ["done", "error", "stopped"].includes(pass.status ?? "") || pass.scores.length > 0 || !!pass.error;
    if (settled) passesDone += 1;
  }
  const missing = passesTotal - passes.length;
  if (missing > 0) callsTotal += missing * (1 + legacyChecklistPer);
  return { callsDone, callsTotal, passesDone, passesTotal };
}

const limitProviderFor = (provider: string): LimitProvider | null =>
  provider === "claude-cli" ? "claude" : provider === "codex-cli" ? "codex" : null;

function providersForSpec(spec: ContenderSpec): LimitProvider[] {
  const refs =
    spec.kind === "solo"
      ? [spec.model]
      : [...spec.proposers, spec.aggregator, ...(Object.values(spec.stageModels ?? {}) as ModelRef[])];
  return refs.map((ref) => limitProviderFor(ref.provider)).filter((provider): provider is LimitProvider => !!provider);
}

function preflightWarnings(contenders: ContenderSpec[], limits: LimitSnapshot): string[] {
  const providers = new Set(contenders.flatMap(providersForSpec));
  return [...providers].flatMap((provider) => {
    const win = limits[provider].session;
    if (!win || win.usedPercent < 85) return [];
    return `${provider === "claude" ? "Claude" : "Codex"} 5h is ${formatPercent(win.usedPercent)} used (${formatResetAt(win.resetsAt)})`;
  });
}

export default function BenchmarksPage() {
  const router = useRouter();
  const [cfg, setCfg] = useState<FuseConfig | null>(null);
  const [tasks, setTasks] = useState<BenchTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("custom");
  const [snapshotStatus, setSnapshotStatus] = useState<Record<string, SnapshotStatus>>({});
  const [preparingTaskId, setPreparingTaskId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [workdirCheck, setWorkdirCheck] = useState<WorkdirCheck | null>(null);
  const [selectedModes, setSelectedModes] = useState<Mode[]>(RECOMMENDED_MODES);
  const [soloRows, setSoloRows] = useState<ModelRef[]>([FABLE_SOLO]);
  const [execute, setExecute] = useState(false);
  const [executor, setExecutor] = useState<ModelRef>(DEFAULT_EXECUTOR);
  const [judges, setJudges] = useState<ModelRef[]>(RECOMMENDED_JUDGES);
  const [judgePasses, setJudgePasses] = useState(2);
  const [reps, setReps] = useState(1);
  const [autoSelected, setAutoSelected] = useState(false);
  const [runs, setRuns] = useState<BenchRunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<BenchRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    // Load app config for the modes' internal models (proposers/aggregator used
    // to build mode contenders) and recent folders. The benchmark selections
    // (task, checked modes, solo, judges, passes/reps) are fixed to the
    // recommended modes-vs-Fable setup and are NOT derived from chat settings.
    loadConfig().then(setCfg);
  }, []);

  useEffect(() => {
    fetch("/api/bench/tasks", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then((next: BenchTask[]) => setTasks(next))
      .catch((e) => setErr(String(e)));
  }, []);

  // Preselect the recommended task once tasks + config have loaded (sets the
  // prompt, checklist, and snapshot folder). Only fires while the user is still
  // on the initial "custom" selection, so it never overrides a manual pick.
  useEffect(() => {
    if (autoSelected || !cfg || !tasks.length || selectedTaskId !== "custom") return;
    const def = tasks.find((t) => t.id === DEFAULT_BENCH_TASK_ID);
    if (def) {
      chooseTask(def);
      setAutoSelected(true);
    }
  }, [autoSelected, cfg, tasks, selectedTaskId]);

  useEffect(() => {
    const sync = () => setSelectedId(new URLSearchParams(window.location.search).get("run"));
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  async function refreshRuns() {
    const res = await fetch("/api/bench", { cache: "no-store" });
    if (res.ok) setRuns(await res.json());
  }

  async function fetchRun(id: string) {
    const res = await fetch(`/api/bench/${id}`, { cache: "no-store" });
    if (res.ok) {
      const next = (await res.json()) as BenchRun;
      setRun(next);
      return next;
    }
    setRun(null);
    return null;
  }

  useEffect(() => {
    refreshRuns().catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setRun(null);
      return;
    }
    fetchRun(selectedId).catch((e) => setErr(String(e)));
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !run || !isLive(run.status)) return;
    const t = setInterval(async () => {
      await fetchRun(selectedId);
      // Keep the History cards in sync too (completedCount + judging x/y),
      // otherwise they stay frozen at their start-of-run counts.
      refreshRuns().catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [selectedId, run?.status]);

  // Safety net: refresh the run list while any run is live even if none is
  // selected, so a background run's card counters stay accurate.
  const anyLive = runs.some((r) => isLive(r.status));
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => refreshRuns().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [anyLive]);

  useEffect(() => {
    if (!run || !isLive(run.status)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run?.status]);

  const selectedTask = useMemo(
    () => (selectedTaskId === "custom" ? null : tasks.find((task) => task.id === selectedTaskId) ?? null),
    [selectedTaskId, tasks],
  );
  const usesSnapshot = !!selectedTask?.repos.length;
  const canExecute = !!selectedTask?.verifier?.steps?.length && !!workdir.trim();

  useEffect(() => {
    if (!canExecute) setExecute(false);
  }, [canExecute]);

  async function prepareSnapshot(task: BenchTask) {
    if (!task.repos.length) return;
    setPreparingTaskId(task.id);
    setErr(null);
    try {
      const res = await fetch(`/api/bench/tasks/${encodeURIComponent(task.id)}/snapshot`, { method: "POST" });
      const data = (await res.json()) as SnapshotStatus & { error?: string };
      if (!res.ok) throw new Error(data?.error ?? "Failed to prepare snapshot");
      setSnapshotStatus((prev) => ({ ...prev, [task.id]: data }));
      if (data.path) setWorkdir(data.path);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setPreparingTaskId(null);
    }
  }

  function chooseTask(task: BenchTask | null) {
    setSelectedTaskId(task?.id ?? "custom");
    setWorkdirCheck(null);
    if (!task) {
      setChecklist([]);
      if (cfg?.workdir) setWorkdir(cfg.workdir);
      return;
    }
    setPrompt(task.prompt);
    setChecklist(task.checklist);
    if (task.builtIn && judges.length < 2) setJudges((prev) => [prev[0] ?? DEFAULT_JUDGE, DEFAULT_SECOND_JUDGE]);
    const snapshot = snapshotStatus[task.id];
    if (snapshot?.path) setWorkdir(snapshot.path);
    else if (task.repos.length) prepareSnapshot(task);
  }

  useEffect(() => {
    if (usesSnapshot || !workdir.trim()) {
      setWorkdirCheck(null);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/bench/workdir-check?path=${encodeURIComponent(workdir.trim())}`, {
          cache: "no-store",
          signal: ac.signal,
        });
        if (res.ok) setWorkdirCheck(await res.json());
      } catch {
        /* best-effort warning */
      }
    }, 350);
    return () => {
      ac.abort();
      clearTimeout(t);
    };
  }, [usesSnapshot, workdir]);

  const contenders = useMemo(() => {
    if (!cfg) return [];
    const modeSpecs: ContenderSpec[] = workdir.trim()
      ? selectedModes.map((mode) => ({
          kind: "mode" as const,
          mode,
          proposers: cfg.proposers,
          aggregator: cfg.aggregator,
          stageModels: cfg.stageModels,
        }))
      : [];
    const soloSpecs: ContenderSpec[] = soloRows
      .filter((row) => row.model.trim())
      .map((model) => ({ kind: "solo" as const, model: { provider: model.provider, model: model.model.trim() } }));
    return [...modeSpecs, ...soloSpecs];
  }, [cfg, selectedModes, soloRows, workdir]);

  const canStart = !!prompt.trim() && contenders.length >= 2 && !starting;

  function openRun(id: string) {
    setSelectedId(id);
    router.push(`/benchmarks?run=${encodeURIComponent(id)}`);
  }

  function toggleMode(mode: Mode) {
    setSelectedModes((prev) => (prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode]));
  }

  async function startRun() {
    if (!canStart) return;
    setStarting(true);
    setErr(null);
    try {
      const limitsRes = await fetch("/api/limits?force=1", { cache: "no-store" });
      if (limitsRes.ok) {
        const warnings = preflightWarnings(contenders, (await limitsRes.json()) as LimitSnapshot);
        if (warnings.length) {
          const ok = window.confirm(
            `This benchmark may hit usage limits:\n\n${warnings.join("\n")}\n\nRun anyway?`,
          );
          if (!ok) return;
        }
      }
      const res = await fetch("/api/bench", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          workdir: workdir.trim() || undefined,
          contenders,
          judge: judges[0],
          judges,
          judgePasses,
          reps,
          taskId: selectedTask?.id,
          checklist: selectedTask ? undefined : checklist,
          execute: canExecute && execute,
          executor: canExecute && execute ? executor : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to start benchmark");
      openRun(data.id);
      await refreshRuns();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setStarting(false);
    }
  }

  async function saveCustomTask() {
    if (!prompt.trim()) return;
    setSavingTask(true);
    setErr(null);
    try {
      const title = prompt.trim().split(/\n+/)[0].replace(/\s+/g, " ").slice(0, 72) || "Custom benchmark task";
      const res = await fetch("/api/bench/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          summary: prompt.trim().replace(/\s+/g, " ").slice(0, 140),
          prompt,
          checklist,
          tags: ["custom"],
        }),
      });
      const task = (await res.json()) as BenchTask & { error?: string };
      if (!res.ok) throw new Error(task?.error ?? "Failed to save task");
      setTasks((prev) => [...prev.filter((item) => item.id !== task.id), task]);
      chooseTask(task);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setSavingTask(false);
    }
  }

  async function stopRun(id: string) {
    await fetch(`/api/bench/${id}/stop`, { method: "POST" });
    await fetchRun(id);
    await refreshRuns();
  }

  async function deleteRun(id: string) {
    await fetch(`/api/bench/${id}`, { method: "DELETE" });
    setRun(null);
    setSelectedId(null);
    router.push("/benchmarks");
    await refreshRuns();
  }

  async function extendRun(id: string, extra: ContenderSpec[]) {
    const res = await fetch(`/api/bench/${id}/extend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contenders: extra }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? "Failed to extend benchmark");
    // The extension may run as a fresh local id (when extending a shared run).
    openRun(data.id);
    await refreshRuns();
  }

  async function publishRun(id: string) {
    const res = await fetch(`/api/bench/${id}/publish`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? "Failed to publish");
    await fetchRun(id);
    await refreshRuns();
    return data as { published?: { commit: string; pushed?: boolean }; pushError?: string };
  }

  if (!cfg) return <div className="p-12 text-lg text-muted">Loading…</div>;

  return (
    <div className="grid h-full grid-cols-1 overflow-hidden lg:grid-cols-[420px_minmax(0,1fr)]">
      <aside className="overflow-y-auto border-b border-border px-6 py-8 lg:border-b-0 lg:border-r">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Benchmarks</h1>
            <p className="mt-2 text-sm text-muted">Compare modes and solo models on one task.</p>
          </div>
        </div>

        <section className="mt-8 space-y-4">
          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Task suite</span>
              {tasks.length > 0 && <span className="text-xs text-muted">{tasks.filter((task) => task.builtIn).length} presets</span>}
            </div>
            <div className="grid gap-2">
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  selected={selectedTaskId === task.id}
                  snapshot={snapshotStatus[task.id]}
                  preparing={preparingTaskId === task.id}
                  onClick={() => chooseTask(task)}
                />
              ))}
              <button
                onClick={() => chooseTask(null)}
                className={`rounded-2xl border p-4 text-left transition ${selectedTaskId === "custom" ? "border-fg" : "border-border hover:border-fg"}`}
              >
                <div className="font-medium">Custom task</div>
                <div className="mt-1 text-xs text-muted">Use any prompt, folder, and optional checklist.</div>
              </button>
            </div>
          </div>

          <label className="block">
            <span className="text-sm font-medium">Prompt</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              readOnly={!!selectedTask}
              rows={7}
              placeholder="Paste the exact task to benchmark…"
              className="mt-2 w-full resize-y rounded-2xl border border-border bg-subtle px-4 py-3 text-base outline-none focus:border-fg read-only:cursor-default read-only:opacity-80"
            />
          </label>

          {checklist.length > 0 && <ChecklistPreview checklist={checklist} />}
          {!selectedTask && <ChecklistEditor checklist={checklist} onChange={setChecklist} />}
          {!selectedTask && (
            <button
              onClick={saveCustomTask}
              disabled={!prompt.trim() || savingTask}
              className="rounded-full border border-border px-4 py-2 text-sm hover:border-fg disabled:opacity-40"
            >
              {savingTask ? "Saving task…" : "Save as task"}
            </button>
          )}

          <label className="block">
            <span className="text-sm font-medium">Working folder</span>
            <input
              value={workdir}
              onChange={(e) => setWorkdir(e.target.value)}
              list="bench-workdirs"
              placeholder="/Users/you/projects/app"
              spellCheck={false}
              className="mt-2 w-full rounded-2xl border border-border bg-subtle px-4 py-3 text-base outline-none focus:border-fg"
            />
            <datalist id="bench-workdirs">
              {cfg.recentFolders.map((folder) => (
                <option key={folder} value={folder} />
              ))}
            </datalist>
            {usesSnapshot && selectedTask && (
              <p className="mt-2 text-xs text-muted">
                Snapshot folder for {selectedTask.title}. {preparingTaskId === selectedTask.id ? "Preparing…" : "Reset before every contender and judge pass."}
              </p>
            )}
            {!usesSnapshot && workdirCheck?.warning && <WorkdirWarning check={workdirCheck} />}
          </label>
        </section>

        <Section title="Modes">
          <div className="space-y-3">
            {MODES.map((mode) => {
              const disabled = !workdir.trim();
              return (
                <label
                  key={mode}
                  className={`block rounded-2xl border border-border p-4 ${disabled ? "opacity-50" : "hover:border-fg"}`}
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={selectedModes.includes(mode)}
                      disabled={disabled}
                      onChange={() => toggleMode(mode)}
                    />
                    <ModeBadge mode={mode} />
                  </div>
                  <div className="mt-3 text-xs leading-relaxed text-muted">
                    Agents: {cfg.proposers.map(modelLabel).join(" + ")}
                    <br />
                    Fuse: {modelLabel(cfg.aggregator)}
                    <StageOverrides cfg={cfg} />
                  </div>
                </label>
              );
            })}
          </div>
          {!workdir.trim() && <p className="mt-3 text-sm text-muted">Mode contenders need a working folder.</p>}
        </Section>

        {canExecute && (
          <Section title="Execution">
            <label className="flex items-start gap-3 rounded-2xl border border-border p-4">
              <input type="checkbox" className="mt-1" checked={execute} onChange={(e) => setExecute(e.target.checked)} />
              <span>
                <span className="text-sm font-medium">Execute &amp; verify (pass@1)</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted">
                  Each contender writes real code, scored by this task&rsquo;s deterministic checks instead of an LLM judge.
                  Modes plan first, then the executor below implements; solo models implement directly. The judge is skipped.
                </span>
              </span>
            </label>
            {execute && (
              <div className="mt-3 space-y-3">
                <div>
                  <span className="text-sm font-medium">Executor (implements mode plans)</span>
                  <div className="mt-2">
                    <ModelPicker value={executor} id="executor" onChange={setExecutor} />
                  </div>
                </div>
                <p className="text-xs leading-relaxed text-muted">
                  Held constant across mode contenders so plan quality is the only variable. For the fair baseline, add a
                  solo model equal to the executor ({modelLabel(executor)}).
                </p>
              </div>
            )}
          </Section>
        )}

        <Section
          title="Solo Models"
          action={
            <button
              onClick={() => setSoloRows((rows) => [...rows, { provider: "claude-cli", model: "claude-sonnet-5" }])}
              className="text-sm underline hover:text-muted"
            >
              Add
            </button>
          }
        >
          <div className="space-y-3">
            {soloRows.map((row, i) => (
              <div key={i} className="flex gap-2">
                <ModelPicker
                  value={row}
                  id={`solo-${i}`}
                  onChange={(next) => setSoloRows((rows) => rows.map((r, j) => (j === i ? next : r)))}
                />
                <button
                  onClick={() => setSoloRows((rows) => rows.filter((_, j) => j !== i))}
                  className="shrink-0 rounded-2xl border border-border px-3 text-muted hover:text-fg"
                  aria-label="Remove solo model"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Judge">
          {execute && (
            <p className="mb-3 rounded-2xl border border-border bg-subtle px-4 py-3 text-xs leading-relaxed text-muted">
              Judge is skipped in execution mode — scoring is the task&rsquo;s deterministic checks. Reps still rerun each
              contender.
            </p>
          )}
          <div className={`space-y-3 ${execute ? "pointer-events-none opacity-40" : ""}`}>
            {judges.map((judge, i) => (
              <div key={i} className="flex gap-2">
                <ModelPicker
                  value={judge}
                  id={`judge-${i}`}
                  onChange={(next) => setJudges((rows) => rows.map((row, j) => (j === i ? next : row)))}
                />
                {judges.length > 1 && (
                  <button
                    onClick={() => setJudges((rows) => rows.filter((_, j) => j !== i))}
                    className="shrink-0 rounded-2xl border border-border px-3 text-muted hover:text-fg"
                    aria-label="Remove judge"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {judges.length < 2 && (
              <button
                onClick={() => setJudges((rows) => [...rows, DEFAULT_SECOND_JUDGE])}
                className="text-sm underline hover:text-muted"
              >
                Add judge
              </button>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <NumberField
              label="Passes"
              value={judgePasses}
              min={1}
              max={5}
              tooltipPlacement="right"
              help="How many times the judge scores the same answers. Higher is more reliable, but takes longer."
              onChange={setJudgePasses}
            />
            <NumberField
              label="Reps"
              value={reps}
              min={1}
              max={3}
              tooltipPlacement="bottom"
              help="How many times to rerun each contender. Higher is fairer, but much slower and uses more tokens."
              onChange={setReps}
            />
          </div>
        </Section>

        {err && <p className="mt-5 rounded-2xl border border-amber-500/40 p-3 text-sm text-amber-600 dark:text-amber-400">{err}</p>}

        <button
          onClick={startRun}
          disabled={!canStart}
          className="mt-6 w-full rounded-full bg-fg px-5 py-3 text-base font-medium text-bg transition hover:opacity-90 disabled:opacity-30"
        >
          {starting ? "Starting…" : "Start benchmark"}
        </button>

        <RunList runs={runs} selectedId={selectedId} onOpen={openRun} />
      </aside>

      <main className="overflow-y-auto px-6 py-8">
        {run ? (
          <RunDetail
            run={run}
            now={now}
            cfg={cfg}
            onStop={() => stopRun(run.id)}
            onDelete={() => deleteRun(run.id)}
            onExtend={extendRun}
            onPublish={publishRun}
          />
        ) : (
          <BenchmarkHistory runs={runs} onOpen={openRun} />
        )}
      </main>
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8 border-t border-border pt-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function TaskCard({
  task,
  selected,
  snapshot,
  preparing,
  onClick,
}: {
  task: BenchTask;
  selected: boolean;
  snapshot?: SnapshotStatus;
  preparing: boolean;
  onClick: () => void;
}) {
  const snapshotLabel = task.repos.length === 0 ? "No repo" : preparing ? "Preparing" : snapshot?.ready ? "Ready" : "Snapshot";
  return (
    <button
      onClick={onClick}
      className={`rounded-2xl border p-4 text-left transition ${selected ? "border-fg" : "border-border hover:border-fg"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{task.title}</div>
          <div className="mt-1 text-xs leading-relaxed text-muted">{task.summary}</div>
        </div>
        <span className="shrink-0 rounded-full border border-border px-2 py-1 text-[11px] text-muted">{snapshotLabel}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {task.tags.slice(0, 4).map((tag) => (
          <span key={tag} className="rounded-full bg-subtle px-2 py-1 text-[11px] text-muted">
            {tag}
          </span>
        ))}
        <span className="rounded-full bg-subtle px-2 py-1 text-[11px] text-muted">{task.checklist.length} checks</span>
      </div>
      {snapshot?.error && <div className="mt-2 text-xs text-amber-600 dark:text-amber-400">{snapshot.error}</div>}
    </button>
  );
}

function ChecklistPreview({ checklist }: { checklist: ChecklistItem[] }) {
  const positive = checklist.filter((item) => item.points > 0).length;
  const penalties = checklist.filter((item) => item.points < 0).length;
  return (
    <details className="rounded-2xl border border-border bg-subtle p-4">
      <summary className="cursor-pointer list-none text-sm font-medium">
        Checklist · {positive} required · {penalties} penalties
      </summary>
      <div className="mt-3 space-y-2">
        {checklist.map((item) => (
          <div key={item.id} className="text-xs leading-relaxed">
            <span className={item.points < 0 ? "text-amber-600 dark:text-amber-400" : "text-muted"}>
              {item.points > 0 ? "+" : ""}
              {item.points} · {item.axis}
            </span>{" "}
            {item.text}
          </div>
        ))}
      </div>
    </details>
  );
}

function ChecklistEditor({
  checklist,
  onChange,
}: {
  checklist: ChecklistItem[];
  onChange: (next: ChecklistItem[]) => void;
}) {
  const update = (index: number, patch: Partial<ChecklistItem>) =>
    onChange(checklist.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  return (
    <div className="rounded-2xl border border-border p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-sm font-medium">Optional checklist</div>
        <button
          onClick={() =>
            onChange([
              ...checklist,
              {
                id: `custom-${Date.now().toString(36)}`,
                text: "",
                points: 1,
                axis: "coverage",
              },
            ])
          }
          className="text-sm underline hover:text-muted"
        >
          Add row
        </button>
      </div>
      {checklist.length === 0 ? (
        <p className="text-xs text-muted">Checklist-less runs use the standard 5-criterion rubric.</p>
      ) : (
        <div className="space-y-3">
          {checklist.map((item, i) => (
            <div key={item.id} className="grid gap-2">
              <input
                value={item.text}
                onChange={(e) => update(i, { text: e.target.value })}
                placeholder="Checklist item"
                className="rounded-2xl border border-border bg-subtle px-3 py-2 text-sm outline-none focus:border-fg"
              />
              <div className="grid grid-cols-[90px_minmax(0,1fr)_42px] gap-2">
                <input
                  type="number"
                  min={-10}
                  max={10}
                  value={item.points}
                  onChange={(e) => update(i, { points: Number(e.target.value) || 0 })}
                  className="rounded-2xl border border-border bg-subtle px-3 py-2 text-sm outline-none focus:border-fg"
                />
                <select
                  value={item.axis}
                  onChange={(e) => update(i, { axis: e.target.value as ChecklistAxis })}
                  className="rounded-2xl border border-border bg-subtle px-3 py-2 text-sm outline-none focus:border-fg"
                >
                  {CHECKLIST_AXES.map((axis) => (
                    <option key={axis} value={axis}>
                      {axis}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => onChange(checklist.filter((_, j) => j !== i))}
                  className="rounded-2xl border border-border text-muted hover:text-fg"
                  aria-label="Remove checklist item"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkdirWarning({ check }: { check: WorkdirCheck }) {
  return (
    <div className="mt-2 rounded-2xl border border-amber-500/40 p-3 text-xs text-amber-700 dark:text-amber-300">
      {check.warning}
      {!!check.litter?.length && <div className="mt-1 truncate text-muted">Litter: {check.litter.slice(0, 4).join(", ")}</div>}
    </div>
  );
}

function StageOverrides({ cfg }: { cfg: FuseConfig }) {
  const entries = Object.entries(cfg.stageModels ?? {}) as [StageKey, ModelRef][];
  if (!entries.length) return null;
  return (
    <>
      <br />
      Overrides: {entries.map(([stage, model]) => `${STAGE_LABELS[stage]} ${model.model}`).join(", ")}
    </>
  );
}

function ModelPicker({
  value,
  id,
  onChange,
}: {
  value: ModelRef;
  id: string;
  onChange: (next: ModelRef) => void;
}) {
  const provider = PROVIDERS.find((p) => p.id === value.provider) ?? PROVIDERS[0];
  const custom = !provider.defaultModels.includes(value.model);
  const modelSelectValue = custom ? "__custom__" : value.model;
  return (
    <div className="flex min-w-0 flex-1 gap-2">
      <select
        value={provider.id}
        onChange={(e) => {
          const next = PROVIDERS.find((p) => p.id === e.target.value) ?? PROVIDERS[0];
          onChange({ provider: next.id, model: next.defaultModels[0] });
        }}
        className="w-32 rounded-2xl border border-border bg-subtle px-3 py-3 text-sm outline-none focus:border-fg"
      >
        {PROVIDERS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        value={modelSelectValue}
        onChange={(e) => {
          const model = e.target.value;
          onChange({ ...value, model: model === "__custom__" ? "" : model });
        }}
        className="min-w-0 flex-1 rounded-2xl border border-border bg-subtle px-3 py-3 text-sm outline-none focus:border-fg"
      >
        {provider.defaultModels.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
        <option value="__custom__">Custom model id…</option>
      </select>
      {(custom || value.model === "") && (
        <input
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
          placeholder="custom model id"
          className="min-w-0 flex-1 rounded-2xl border border-border bg-subtle px-3 py-3 text-sm outline-none focus:border-fg"
        />
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  help,
  tooltipPlacement = "right",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  help: string;
  tooltipPlacement?: "right" | "bottom";
  onChange: (value: number) => void;
}) {
  const id = `bench-number-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div className="block">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <HelpTooltip text={help} placement={tooltipPlacement} />
      </div>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
        className="mt-2 w-full rounded-2xl border border-border bg-subtle px-4 py-3 text-base outline-none focus:border-fg"
      />
    </div>
  );
}

function HelpTooltip({ text, placement }: { text: string; placement: "right" | "bottom" }) {
  const position =
    placement === "bottom"
      ? "left-1/2 top-7 -translate-x-1/2"
      : "left-7 top-1/2 -translate-y-1/2";
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={text}
        className="flex h-5 w-5 items-center justify-center rounded-full border border-border text-xs font-semibold text-muted transition hover:border-fg hover:text-fg focus:border-fg focus:text-fg focus:outline-none"
      >
        ?
      </button>
      <span className={`pointer-events-none absolute z-20 hidden w-56 rounded-2xl border border-border bg-bg p-3 text-xs font-normal leading-relaxed text-fg shadow-lg group-hover:block group-focus-within:block ${position}`}>
        {text}
      </span>
    </span>
  );
}

function RunList({
  runs,
  selectedId,
  onOpen,
}: {
  runs: BenchRunSummary[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="mt-8 border-t border-border pt-6">
      <h2 className="text-lg font-semibold">History</h2>
      {runs.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No benchmark runs yet.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {runs.map((run) => (
            <button
              key={run.id}
              onClick={() => onOpen(run.id)}
              className={`block w-full rounded-2xl border p-4 text-left transition ${
                selectedId === run.id ? "border-fg" : "border-border hover:border-fg"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{run.taskTitle || run.promptExcerpt || "Untitled benchmark"}</span>
                    {run.shared && <SharedBadge />}
                    {run.published && !run.shared && <PublishedBadge />}
                  </div>
                  <div className="mt-1 text-xs text-muted">{fmtDate(run.createdAt)}</div>
                </div>
                <StatusChip status={run.status} />
              </div>
              <div className="mt-3 text-xs text-muted">
                {run.completedCount}/{run.resultCount} finished · {run.contenderLabels.length} contenders · {run.reps} rep
                {run.reps === 1 ? "" : "s"}
                {run.execute ? " · execute" : ""}
                {run.status === "judging" && run.judgeCallsTotal
                  ? ` · judging ${run.judgeCallsDone ?? 0}/${run.judgeCallsTotal} calls`
                  : ""}
              </div>
              {run.execute && run.attemptCount ? (
                <div className="mt-2 truncate text-xs">
                  <span className={run.resolvedCount ? "text-emerald-600 dark:text-emerald-400" : "text-muted"}>
                    {run.resolvedCount ?? 0}/{run.attemptCount} resolved
                  </span>
                  {run.best ? ` · best ${run.best.label}` : ""}
                </div>
              ) : run.best ? (
                <div className="mt-2 truncate text-xs">
                  Best: {run.best.label} · {fmtRunScore(run.best.composite, run.best.scoreSource)} ±{" "}
                  {fmtRunScore(run.best.spread, run.best.scoreSource)}
                </div>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function BenchmarkHistory({ runs, onOpen }: { runs: BenchRunSummary[]; onOpen: (id: string) => void }) {
  const completed = runs.filter((run) => run.status === "done").length;
  const live = runs.filter((run) => isLive(run.status)).length;
  const judged = runs.filter((run) => !!run.best).length;
  const tokens = runs.reduce((sum, run) => sum + (run.totalTokens ?? 0), 0);
  const limitCost = runs.reduce((sum, run) => sum + (run.totalLimitSessionPct ?? 0), 0);

  if (!runs.length) {
    return (
      <div className="flex h-full items-center justify-center text-center text-muted">
        <div>
          <div className="text-2xl font-semibold text-fg">No benchmark history yet</div>
          <p className="mt-2">Start a run from the left panel.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Benchmark history</h2>
          <p className="mt-2 text-sm text-muted">{runs.length} saved run{runs.length === 1 ? "" : "s"}</p>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <HistoryMetric label="Completed" value={String(completed)} />
        <HistoryMetric label="Live" value={String(live)} />
        <HistoryMetric label="Judged" value={String(judged)} />
        <HistoryMetric label="Tokens" value={fmtNum(tokens)} />
        <HistoryMetric label="≈5h cost" value={fmtLimitPct(limitCost)} />
      </div>

      <div className="mt-8 overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Run</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Best</th>
              <th className="px-4 py-3">Setup</th>
              <th className="px-4 py-3 text-right">Time</th>
              <th className="px-4 py-3 text-right">Tokens</th>
              <th className="px-4 py-3 text-right">≈5h</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} className="border-b border-border last:border-b-0">
                <td className="px-4 py-3">
                  <button onClick={() => onOpen(run.id)} className="block max-w-md text-left hover:text-muted">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">{run.taskTitle || run.promptExcerpt || "Untitled benchmark"}</span>
                      {run.shared && <SharedBadge />}
                      {run.published && !run.shared && <PublishedBadge />}
                    </span>
                    <span className="mt-1 block text-xs text-muted">
                      {fmtDate(run.createdAt)}
                      {run.taskId ? ` · ${run.taskId}` : ""}
                    </span>
                  </button>
                </td>
                <td className="px-4 py-3">
                  <StatusChip status={run.status} />
                </td>
                <td className="px-4 py-3">
                  {run.execute && run.attemptCount ? (
                    <div className="max-w-xs">
                      <div className={`font-medium ${run.resolvedCount ? "text-emerald-600 dark:text-emerald-400" : ""}`}>
                        {run.resolvedCount ?? 0}/{run.attemptCount} resolved
                      </div>
                      <div className="mt-1 truncate text-xs text-muted">
                        {run.best ? `best ${run.best.label} · ${fmtPct(run.best.composite)} checks` : "—"}
                      </div>
                    </div>
                  ) : run.best ? (
                    <div className="max-w-xs">
                      <div className="truncate font-medium">{run.best.label}</div>
                      <div className="mt-1 text-xs text-muted">
                        {fmtRunScore(run.best.composite, run.best.scoreSource)} ± {fmtRunScore(run.best.spread, run.best.scoreSource)}
                        {run.scoreSource ? ` · ${run.scoreSource}` : ""}
                      </div>
                    </div>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-muted">
                  {run.execute ? (
                    <>
                      <div>
                        {run.contenderLabels.length} contender{run.contenderLabels.length === 1 ? "" : "s"} · {run.reps} rep
                        {run.reps === 1 ? "" : "s"} · execute &amp; verify
                      </div>
                      <div className="mt-1 truncate">deterministic checks</div>
                    </>
                  ) : (
                    <>
                      <div>
                        {run.contenderLabels.length} contender{run.contenderLabels.length === 1 ? "" : "s"} · {run.reps} rep
                        {run.reps === 1 ? "" : "s"} · {run.judgePasses} pass{run.judgePasses === 1 ? "" : "es"}
                      </div>
                      <div className="mt-1 truncate">{run.judgeLabels.join(" + ") || "No judge"}</div>
                    </>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-muted">{fmtMs(run.elapsedMs)}</td>
                <td className="px-4 py-3 text-right text-muted">{fmtNum(run.totalTokens)}</td>
                <td className="px-4 py-3 text-right text-muted">{fmtLimitPct(run.totalLimitSessionPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HistoryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-subtle p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function RunDetail({
  run,
  now,
  cfg,
  onStop,
  onDelete,
  onExtend,
  onPublish,
}: {
  run: BenchRun;
  now: number;
  cfg: FuseConfig;
  onStop: () => void;
  onDelete: () => void;
  onExtend: (id: string, extra: ContenderSpec[]) => Promise<void>;
  onPublish: (id: string) => Promise<{ published?: { commit: string; pushed?: boolean }; pushError?: string }>;
}) {
  const finished = !isLive(run.status);
  // Idle timeout (5 min) + slack: past this with no persisted progress, a judge
  // CLI call may be wedged. cli.ts owns the actual kill; we only surface it.
  const stalledMs = 12 * 60 * 1000;
  const stalled = isLive(run.status) && now - run.updatedAt > stalledMs;
  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-3xl font-semibold tracking-tight">Benchmark run</h2>
            <StatusChip status={run.status} />
            {run.shared && <SharedBadge />}
            {run.published && !run.shared && <PublishedBadge />}
          </div>
          <p className="mt-2 text-sm text-muted">
            {run.config.execute ? (
              <>
                {fmtDate(run.createdAt)} · execute &amp; verify · executor {run.config.executor ? modelLabel(run.config.executor) : "—"} ·{" "}
                {run.config.reps} rep{run.config.reps === 1 ? "" : "s"}
              </>
            ) : (
              <>
                {fmtDate(run.createdAt)} · {(run.config.judges?.length ? run.config.judges : run.config.judge ? [run.config.judge] : []).map(modelLabel).join(" + ")} · {run.config.judgePasses} judge pass
                {run.config.judgePasses === 1 ? "" : "es"}
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {finished && !run.shared && !run.config.execute && <PublishButton run={run} onPublish={onPublish} />}
          {isLive(run.status) && (
            <button onClick={onStop} className="rounded-full border border-border px-4 py-2 text-sm hover:border-fg">
              Stop
            </button>
          )}
          {finished && !run.shared && (
            <button onClick={onDelete} className="rounded-full border border-border px-4 py-2 text-sm text-muted hover:text-fg">
              Delete
            </button>
          )}
        </div>
      </div>

      {run.error && <p className="mt-6 rounded-2xl border border-amber-500/40 bg-amber-500/5 px-5 py-4 text-sm text-amber-600 dark:text-amber-400">{run.error}</p>}

      {run.publishError && (
        <p className="mt-4 rounded-2xl border border-amber-500/40 bg-amber-500/5 px-5 py-4 text-sm text-amber-600 dark:text-amber-400">
          Publish note: {run.publishError}
        </p>
      )}

      {stalled && (
        <p className="mt-4 rounded-2xl border border-amber-500/40 bg-amber-500/5 px-5 py-4 text-sm text-amber-600 dark:text-amber-400">
          No progress for {fmtMs(now - run.updatedAt)} — a judge CLI call may be wedged. It will be killed by the idle
          timeout, or you can Stop the run.
        </p>
      )}

      {run.summary && run.summary.length > 0 && <ResultsComparison run={run} />}

      <section className="mt-8">
        <h3 className="text-xl font-semibold">Contenders</h3>
        <div className="mt-4 overflow-hidden rounded-2xl border border-border">
          {run.results.map((result, index) => {
            const elapsed = result.status === "running" && result.startedAt ? now - result.startedAt : result.elapsedMs;
            return (
              <div key={index} className="grid gap-3 border-b border-border p-4 last:border-b-0 md:grid-cols-[minmax(0,1fr)_110px_110px_130px_90px] md:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {result.spec.kind === "mode" && <ModeBadge mode={result.spec.mode} />}
                    <span className="truncate font-medium">{resultLabel(result)}</span>
                    {result.extension && <AddedBadge />}
                    {result.verifier && <ResolvedChip verifier={result.verifier} />}
                  </div>
                  {result.error && <p className="mt-1 truncate text-sm text-muted">{result.error}</p>}
                </div>
                <StatusChip status={result.status} />
                <span className="text-sm text-muted">{fmtMs(elapsed)}</span>
                <span className="text-sm text-muted">{fmtNum(result.usage?.total_tokens)} tokens</span>
                <span className="text-sm text-muted">{fmtLimitPct(totalSessionDelta(result.limitDelta))}</span>
              </div>
            );
          })}
        </div>
        {finished && <AddContendersPanel run={run} cfg={cfg} onExtend={onExtend} />}
      </section>

      {!run.config.execute && (run.judgePasses.length > 0 || run.status === "judging") && (
        <JudgesSection run={run} now={now} />
      )}

      <section className="mt-8">
        <h3 className="text-xl font-semibold">Outputs</h3>
        <div className="mt-4 space-y-3">
          {run.results.map((result, index) => (
            <ResultDetails key={index} run={run} result={result} index={index} />
          ))}
        </div>
      </section>

      <details className="mt-8 rounded-2xl border border-border bg-subtle px-5 py-4">
        <summary className="cursor-pointer text-sm font-medium">
          <span>Task</span>
          {run.config.taskTitle && <span className="ml-2 text-muted">{run.config.taskTitle}</span>}
        </summary>
        <div className="mt-4 border-t border-border pt-4">
          {run.config.taskId && <p className="text-xs text-muted">Task id: {run.config.taskId}</p>}
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{run.config.prompt}</p>
          {run.config.workdir && <p className="mt-3 text-xs text-muted">Folder: {run.config.workdir}</p>}
          {run.config.checklist?.length ? (
            <p className="mt-2 text-xs text-muted">{run.config.checklist.length} checklist items were denormalized into this run.</p>
          ) : null}
        </div>
      </details>
    </div>
  );
}

function AddedBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-violet-500/40 px-2 py-0.5 text-[11px] font-medium text-violet-600 dark:text-violet-400">
      added later
    </span>
  );
}

// ---- Judges: live per-pass progress, mirroring the Contenders section ----

function JudgesSection({ run, now }: { run: BenchRun; now: number }) {
  const { callsDone, callsTotal, passesDone, passesTotal } = judgeProgress(run);
  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 className="text-xl font-semibold">Judges</h3>
        <div className="text-xs text-muted">
          {callsDone}/{callsTotal} calls · {passesDone} of {passesTotal} passes done
          {run.status === "judging" && (
            <span className="ml-1">· each call is a full CLI session over the repo — typically 2–10 min</span>
          )}
        </div>
      </div>
      <div className="mt-4 overflow-hidden rounded-2xl border border-border">
        {run.judgePasses.map((pass, index) => {
          const status = passDisplayStatus(run, pass);
          const elapsed =
            status === "running" && pass.startedAt
              ? now - pass.startedAt
              : pass.startedAt && pass.endedAt
                ? pass.endedAt - pass.startedAt
                : undefined;
          const sub =
            status === "error"
              ? pass.error
              : status === "running"
                ? pass.step === "checklist"
                  ? `rubric done · checklist ${pass.checklistDone ?? 0}/${pass.checklistTotal ?? 0}`
                  : "rubric…"
                : status === "done" && (pass.checklistTotal ?? 0) > 0
                  ? `rubric done · checklist ${pass.checklistDone ?? pass.checklistTotal}/${pass.checklistTotal}`
                  : undefined;
          return (
            <div
              key={index}
              className="grid gap-3 border-b border-border p-4 last:border-b-0 md:grid-cols-[minmax(0,1fr)_130px_110px_130px] md:items-center"
            >
              <div className="min-w-0">
                <span className="truncate font-medium">
                  Pass {pass.pass}
                  {pass.judge ? ` · ${modelLabel(pass.judge)}` : ""}
                </span>
                {sub && <p className="mt-1 truncate text-sm text-muted">{sub}</p>}
              </div>
              <JudgePassChip status={status} />
              <span className="text-sm text-muted">{fmtMs(elapsed)}</span>
              <span className="text-sm text-muted">{fmtNum(pass.usage?.total_tokens)} tokens</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---- Publish to git ----

function PublishButton({
  run,
  onPublish,
}: {
  run: BenchRun;
  onPublish: (id: string) => Promise<{ published?: { commit: string; pushed?: boolean }; pushError?: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const published = run.published;
  async function go() {
    setBusy(true);
    setErr(null);
    try {
      await onPublish(run.id);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      // First publish in the packaged app has no results repo configured. Prompt
      // for the local Fuse clone once (native folder picker), save it, and retry
      // — instead of surfacing a raw "not configured" error.
      if (/no benchmark results repo/i.test(msg)) {
        const dir = await (window as any).fuse?.chooseFolder?.().catch(() => undefined);
        if (dir) {
          try {
            const current = await loadConfig();
            await saveConfig({ ...current, benchResultsRepo: dir });
            await onPublish(run.id);
          } catch (e2: any) {
            setErr(e2?.message ?? String(e2));
          }
        } else {
          setErr("Set your local Fuse clone in Settings → Benchmarks, then publish.");
        }
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-2">
      {err && <span className="max-w-[220px] truncate text-xs text-amber-600 dark:text-amber-400">{err}</span>}
      <button
        onClick={go}
        disabled={busy}
        className="rounded-full border border-border px-4 py-2 text-sm hover:border-fg disabled:opacity-40"
        title={published ? `Published to ${published.commit.slice(0, 7)}${published.pushed === false ? " (not pushed)" : ""}` : "Export to the results repo and commit + push"}
      >
        {busy
          ? "Publishing…"
          : published
            ? `Published ✓ ${published.commit.slice(0, 7)}${published.pushed === false ? " (local)" : ""}`
            : "Publish to git"}
      </button>
    </div>
  );
}

// ---- Add contenders to a finished run (reuses existing outputs + verdicts) ----

function AddContendersPanel({
  run,
  cfg,
  onExtend,
}: {
  run: BenchRun;
  cfg: FuseConfig;
  onExtend: (id: string, extra: ContenderSpec[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [modes, setModes] = useState<Mode[]>([]);
  const [soloRows, setSoloRows] = useState<ModelRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const hasWorkdir = !!run.config.workdir;
  const existingModes = new Set(
    run.results.filter((r) => r.spec.kind === "mode").map((r) => (r.spec.kind === "mode" ? r.spec.mode : "")),
  );

  const extra = useMemo<ContenderSpec[]>(() => {
    const modeSpecs: ContenderSpec[] = hasWorkdir
      ? modes.map((mode) => ({
          kind: "mode" as const,
          mode,
          proposers: cfg.proposers,
          aggregator: cfg.aggregator,
          stageModels: cfg.stageModels,
        }))
      : [];
    const soloSpecs: ContenderSpec[] = soloRows
      .filter((row) => row.model.trim())
      .map((model) => ({ kind: "solo" as const, model: { provider: model.provider, model: model.model.trim() } }));
    return [...modeSpecs, ...soloSpecs];
  }, [hasWorkdir, modes, soloRows, cfg]);

  function toggleMode(mode: Mode) {
    setModes((prev) => (prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode]));
  }

  async function submit() {
    if (!extra.length) return;
    setBusy(true);
    setErr(null);
    try {
      // Preflight limit warning, mirroring the start form.
      const limitsRes = await fetch("/api/limits?force=1", { cache: "no-store" });
      if (limitsRes.ok) {
        const warnings = preflightWarnings(extra, (await limitsRes.json()) as LimitSnapshot);
        if (warnings.length && !window.confirm(`This may hit usage limits:\n\n${warnings.join("\n")}\n\nRun anyway?`)) {
          setBusy(false);
          return;
        }
      }
      await onExtend(run.id, extra);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="mt-4 rounded-2xl border border-border bg-subtle px-5 py-4"
    >
      <summary className="cursor-pointer text-sm font-medium">
        Add contenders
        <span className="ml-2 font-normal text-muted">reuses existing outputs &amp; judge verdicts — only new contenders run</span>
      </summary>
      <div className="mt-4 space-y-4 border-t border-border pt-4">
        {run.config.execute && (
          <p className="text-xs text-muted">Execution run: new contenders implement + are verified; no judging.</p>
        )}
        {hasWorkdir ? (
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Modes</div>
            <div className="flex flex-wrap gap-3">
              {MODES.map((mode) => (
                <label key={mode} className="flex items-center gap-2 rounded-2xl border border-border px-3 py-2">
                  <input type="checkbox" checked={modes.includes(mode)} onChange={() => toggleMode(mode)} />
                  <ModeBadge mode={mode} />
                  {existingModes.has(mode) && <span className="text-[11px] text-muted">in run</span>}
                </label>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted">This run has no working folder, so only solo models can be added.</p>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Solo models</span>
            <button
              onClick={() => setSoloRows((rows) => [...rows, { provider: "claude-cli", model: "claude-sonnet-5" }])}
              className="text-sm underline hover:text-muted"
            >
              Add
            </button>
          </div>
          <div className="space-y-2">
            {soloRows.map((row, i) => (
              <div key={i} className="flex gap-2">
                <ModelPicker
                  value={row}
                  id={`extend-solo-${i}`}
                  onChange={(next) => setSoloRows((rows) => rows.map((r, j) => (j === i ? next : r)))}
                />
                <button
                  onClick={() => setSoloRows((rows) => rows.filter((_, j) => j !== i))}
                  className="shrink-0 rounded-2xl border border-border px-3 text-muted hover:text-fg"
                  aria-label="Remove solo model"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        {err && <p className="rounded-2xl border border-amber-500/40 p-3 text-sm text-amber-600 dark:text-amber-400">{err}</p>}

        <button
          onClick={submit}
          disabled={!extra.length || busy}
          className="rounded-full bg-fg px-5 py-2.5 text-sm font-medium text-bg transition hover:opacity-90 disabled:opacity-30"
        >
          {busy
            ? "Starting…"
            : `Add ${extra.length} contender${extra.length === 1 ? "" : "s"}${run.config.reps > 1 ? ` × ${run.config.reps} reps` : ""}`}
        </button>
      </div>
    </details>
  );
}

// ---- Results comparison: chart + transposed compare table + AI export ----

const CONTENDER_COLORS = ["#8b5cf6", "#22c55e", "#f59e0b", "#3b82f6", "#ec4899", "#14b8a6", "#eab308", "#f43f5e"];
const contenderColor = (i: number) => CONTENDER_COLORS[i % CONTENDER_COLORS.length];
const CHART_TOOLTIP = {
  background: "var(--subtle)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  color: "var(--fg)",
} as const;

interface TriggeredPenalty {
  id: string;
  text: string;
  points: number;
  axis: ChecklistAxis;
  yes: number;
  total: number;
}
interface PenaltyStat {
  hasChecklist: boolean;
  wrongClaims: number;
  fabrications: number;
  triggered: TriggeredPenalty[];
}

// Wrong claims / fabrications are derived from the judge's checklist verdicts on
// the task's penalty items (points < 0). An item counts as triggered when a
// majority of judge passes marked it "yes" (the model did the bad thing).
// Fabrications are the grounding-axis subset (invented paths/APIs/flows).
function penaltyStatsFor(run: BenchRun, resultIndex: number): PenaltyStat {
  const penalties = (run.config.checklist ?? []).filter((it) => it.points < 0);
  if (!penalties.length) return { hasChecklist: false, wrongClaims: 0, fabrications: 0, triggered: [] };
  const triggered: TriggeredPenalty[] = [];
  for (const it of penalties) {
    let yes = 0;
    let total = 0;
    for (const pass of run.judgePasses) {
      const verdict = pass.scores
        .find((s) => s.resultIndex === resultIndex)
        ?.checklist?.find((c) => c.itemId === it.id)?.verdict;
      if (verdict === "yes" || verdict === "no") {
        total++;
        if (verdict === "yes") yes++;
      }
    }
    if (total > 0 && yes * 2 >= total) {
      triggered.push({ id: it.id, text: it.text, points: it.points, axis: it.axis, yes, total });
    }
  }
  return {
    hasChecklist: true,
    wrongClaims: triggered.length,
    fabrications: triggered.filter((t) => t.axis === "grounding").length,
    triggered,
  };
}

interface ContenderView {
  rank: number;
  row: BenchSummaryRow;
  result: ContenderResult;
  label: string;
  short: string;
  color: string;
  pen: PenaltyStat;
  scoreSource: ScoreSource;
  checklist: boolean;
  verifier: boolean;
  percent: boolean;
}

function contenderViews(run: BenchRun): ContenderView[] {
  return (run.summary ?? []).map((row, rank) => {
    const result = run.results[row.resultIndex];
    const short = result.spec.kind === "mode" ? result.spec.mode : result.spec.model.model || "solo";
    const scoreSource: ScoreSource = row.scoreSource ?? "rubric";
    return {
      rank,
      row,
      result,
      label: resultLabel(result),
      short,
      color: contenderColor(rank),
      pen: penaltyStatsFor(run, row.resultIndex),
      scoreSource,
      checklist: scoreSource === "checklist",
      verifier: scoreSource === "verifier",
      percent: isPercentSource(scoreSource),
    };
  });
}

function judgeNotesFor(run: BenchRun, resultIndex: number) {
  return run.judgePasses
    .map((pass) => {
      const score = pass.scores.find((s) => s.resultIndex === resultIndex);
      if (!score && !pass.error) return null;
      return {
        pass: pass.pass,
        judge: pass.judge ? `${pass.judge.provider}/${pass.judge.model}` : undefined,
        error: pass.error,
        composite: score?.composite,
        checklistScore: score?.checklistScore,
        rationale: score?.rationale,
        checklist: score?.checklist,
      };
    })
    .filter((n): n is NonNullable<typeof n> => n !== null);
}

function judgeList(run: BenchRun): string[] {
  const js = run.config.judges ?? (run.config.judge ? [run.config.judge] : []);
  return js.map((j) => `${j.provider}/${j.model}`);
}

// Structured JSON dump — everything an AI needs to reason about the modes.
function buildAnalysisJson(run: BenchRun) {
  const views = contenderViews(run);
  return {
    id: run.id,
    createdAt: new Date(run.createdAt).toISOString(),
    status: run.status,
    scoreSource: views[0]?.scoreSource ?? "rubric",
    execute: run.config.execute ?? false,
    executor: run.config.execute ? run.config.executor : undefined,
    judges: judgeList(run),
    judgePasses: run.config.judgePasses,
    reps: run.config.reps,
    task: {
      id: run.config.taskId,
      title: run.config.taskTitle,
      prompt: run.config.prompt,
      workdir: run.config.workdir,
      checklist: run.config.checklist,
    },
    contenders: views.map((v) => ({
      rank: v.rank + 1,
      label: v.label,
      mode: v.result.spec.kind === "mode" ? v.result.spec.mode : undefined,
      resolved: v.verifier ? v.row.resolved : undefined,
      hardChecks: v.verifier ? `${v.row.hardPassed ?? 0}/${v.row.hardTotal ?? 0}` : undefined,
      checksPassedPct: v.verifier ? v.row.composite : undefined,
      verifierSteps: v.result.verifier?.steps,
      diffStat: v.result.verifier?.diffStat,
      overallScore: v.row.composite,
      spread: v.row.spread,
      worstRep: v.row.worstRep,
      perCriterion: v.verifier ? undefined : v.row.perCriterion,
      wrongClaims: v.pen.hasChecklist ? v.pen.wrongClaims : null,
      fabrications: v.pen.hasChecklist ? v.pen.fabrications : null,
      triggeredPenalties: v.pen.triggered.map((t) => ({
        id: t.id,
        axis: t.axis,
        fabrication: t.axis === "grounding",
        points: t.points,
        judgeAgreement: `${t.yes}/${t.total}`,
        text: t.text,
      })),
      elapsedMs: v.result.elapsedMs,
      totalTokens: v.result.usage?.total_tokens,
      limitSessionPct: totalSessionDelta(v.result.limitDelta),
      judgeNotes: judgeNotesFor(run, v.row.resultIndex),
      output: v.result.final,
      usageItems: v.result.usageItems,
    })),
  };
}

// Rich Markdown report — paste straight into an AI to improve the modes.
function buildAnalysisMarkdown(run: BenchRun): string {
  const views = contenderViews(run);
  const scoreSource = views[0]?.scoreSource ?? "rubric";
  const verifier = scoreSource === "verifier";
  const percent = scoreSource === "checklist" || verifier;
  const fmt = (n?: number) => (n === undefined ? "—" : percent ? `${n.toFixed(1)}%` : n.toFixed(1));
  const crit = scoreSource === "rubric" ? (BENCH_CRITERIA as readonly (typeof BENCH_CRITERIA)[number][]) : [];
  const L: string[] = [];
  L.push(`# Benchmark report — ${run.config.taskTitle || run.config.prompt.slice(0, 80)}`);
  L.push("");
  L.push(`- Run \`${run.id}\` · ${new Date(run.createdAt).toLocaleString()} · status: ${run.status}`);
  if (verifier) {
    L.push(`- Scoring: execution verifier (pass@1) · executor ${run.config.executor ? modelLabel(run.config.executor) : "—"} · ${run.config.reps} rep(s)`);
  } else {
    L.push(`- Scoring: ${scoreSource === "checklist" ? "checklist (%)" : "rubric (0–10)"} · ${run.config.judgePasses} judge pass(es) · ${run.config.reps} rep(s)`);
    L.push(`- Judges: ${judgeList(run).join(", ") || "—"}`);
  }
  if (run.config.workdir) L.push(`- Workdir: \`${run.config.workdir}\``);
  L.push("");
  L.push("## Task prompt");
  L.push("```");
  L.push(run.config.prompt);
  L.push("```");
  L.push("");
  L.push("## Ranking");
  L.push("");
  const head = verifier
    ? ["Rank", "Contender", "Resolved", "Hard checks", "Checks %", "Time", "Tokens", "≈5h"]
    : ["Rank", "Contender", "Score", "Worst rep", "Wrong claims", "Fabrications", ...crit.map((c) => BENCH_CRITERION_LABELS[c]), "Time", "Tokens", "≈5h"];
  L.push(`| ${head.join(" | ")} |`);
  L.push(`|${head.map(() => "---").join("|")}|`);
  for (const v of views) {
    const cells = verifier
      ? [
          `${v.rank + 1}${v.rank === 0 ? " 🥇" : ""}`,
          v.label,
          v.row.resolved ? "✓" : "✗",
          `${v.row.hardPassed ?? 0}/${v.row.hardTotal ?? 0}`,
          fmtPct(v.row.composite),
          fmtMs(v.result.elapsedMs),
          fmtNum(v.result.usage?.total_tokens),
          fmtLimitPct(totalSessionDelta(v.result.limitDelta)),
        ]
      : [
          `${v.rank + 1}${v.rank === 0 ? " 🥇" : ""}`,
          v.label,
          `${fmt(v.row.composite)} ± ${fmt(v.row.spread)}`,
          fmt(v.row.worstRep),
          v.pen.hasChecklist ? String(v.pen.wrongClaims) : "—",
          v.pen.hasChecklist ? String(v.pen.fabrications) : "—",
          ...crit.map((c) => fmtScore(v.row.perCriterion[c])),
          fmtMs(v.result.elapsedMs),
          fmtNum(v.result.usage?.total_tokens),
          fmtLimitPct(totalSessionDelta(v.result.limitDelta)),
        ];
    L.push(`| ${cells.join(" | ")} |`);
  }
  L.push("");
  L.push("## Per-contender detail");
  for (const v of views) {
    L.push("");
    L.push(`### #${v.rank + 1}${v.rank === 0 ? " 🥇" : ""} ${v.label}`);
    if (verifier) {
      L.push(`- Verdict: ${v.row.resolved ? "RESOLVED ✓" : "NOT RESOLVED ✗"} · hard ${v.row.hardPassed ?? 0}/${v.row.hardTotal ?? 0} · checks ${fmtPct(v.row.composite)}`);
      const steps = v.result.verifier?.steps ?? [];
      for (const s of steps) L.push(`  - ${s.passed ? "✅" : "❌"}${s.soft ? " (soft)" : ""} ${s.label}${s.detail ? ` — ${s.detail}` : ""}`);
      if (v.result.verifier?.diffStat) L.push(`- Diff: ${v.result.verifier.diffStat.replace(/\n/g, "; ")}`);
    } else {
      L.push(`- Overall: ${fmt(v.row.composite)} ± ${fmt(v.row.spread)} (worst rep ${fmt(v.row.worstRep)})`);
      if (scoreSource === "rubric") L.push(`- Per-criterion: ${BENCH_CRITERIA.map((c) => `${BENCH_CRITERION_LABELS[c]} ${fmtScore(v.row.perCriterion[c])}`).join(", ")}`);
    }
    L.push(`- Time ${fmtMs(v.result.elapsedMs)} · Tokens ${fmtNum(v.result.usage?.total_tokens)} · ≈5h ${fmtLimitPct(totalSessionDelta(v.result.limitDelta))}`);
    if (v.pen.hasChecklist && !verifier) {
      L.push(`- Wrong claims: ${v.pen.wrongClaims} · Fabrications: ${v.pen.fabrications}`);
      for (const t of v.pen.triggered) {
        L.push(`  - [${t.axis}${t.axis === "grounding" ? ", fabrication" : ""}] (${t.points}pt, agree ${t.yes}/${t.total}) ${t.text}`);
      }
    }
    const notes = judgeNotesFor(run, v.row.resultIndex);
    if (notes.length) {
      L.push(`- Judge notes:`);
      for (const n of notes) {
        if (n.error) {
          L.push(`  - Pass ${n.pass}${n.judge ? ` (${n.judge})` : ""}: ERROR ${n.error}`);
          continue;
        }
        const s = n.checklistScore !== undefined ? `${n.checklistScore.toFixed(1)}%` : n.composite !== undefined ? n.composite.toFixed(1) : "—";
        L.push(`  - Pass ${n.pass}${n.judge ? ` (${n.judge})` : ""} — ${s}: ${(n.rationale || "—").replace(/\s+/g, " ").trim()}`);
      }
    }
    if (v.result.final) {
      L.push("");
      L.push(`<details><summary>Plan output — #${v.rank + 1} ${v.label}</summary>`);
      L.push("");
      L.push("~~~markdown");
      L.push(v.result.final);
      L.push("~~~");
      L.push("");
      L.push("</details>");
    }
  }
  L.push("");
  L.push("## Analysis task");
  L.push("You are improving Fuse's plan modes (Fast / Relay / Recon), each a multi-stage local-CLI pipeline defined in `lib/plan.ts`. Using the scores, penalties, judge rationales, and full plan outputs above:");
  L.push("1. Explain WHY each lower-ranked contender lost — cite specific criteria gaps, wrong claims/fabrications, and judge critiques.");
  L.push("2. Compare the plan outputs qualitatively (grounding, requirement coverage, actionability, testing, scope discipline).");
  L.push("3. Propose concrete, minimal changes to each mode's stage prompts/flow to raise its weakest dimensions without regressing others.");
  L.push("4. Flag judge unreliability (large spread across passes) that would undermine these conclusions.");
  return L.join("\n");
}

function useCopyDownload() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const download = (name: string, text: string, type: string) => {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  return { copied, copy, download };
}

function ScoreChart({ views, percent, verifier }: { views: ContenderView[]; percent: boolean; verifier: boolean }) {
  const data = views.map((v) => ({
    name: `${v.short}${v.rank === 0 ? " 🥇" : ""}`,
    score: Number((v.row.composite ?? 0).toFixed(1)),
    fill: v.color,
  }));
  const title = verifier ? "Checks passed (%)" : `Overall score ${percent ? "(%)" : "(0–10)"}`;
  return (
    <div className="rounded-2xl border border-border p-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{title}</div>
      <ResponsiveContainer width="100%" height={Math.max(150, views.length * 44)}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 40 }}>
          <XAxis type="number" domain={[0, percent ? 100 : 10]} tick={{ fontSize: 12 }} />
          <YAxis type="category" dataKey="name" width={128} tick={{ fontSize: 12 }} />
          <Tooltip contentStyle={CHART_TOOLTIP} cursor={{ fill: "var(--subtle)" }} />
          <Bar dataKey="score" radius={[0, 6, 6, 0]} label={{ position: "right", fontSize: 12, fill: "var(--muted)" }}>
            {data.map((d, i) => (
              <Cell key={i} style={{ fill: d.fill }} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function CriteriaChart({ views }: { views: ContenderView[] }) {
  const data = BENCH_CRITERIA.map((c) => {
    const row: Record<string, string | number> = { criterion: BENCH_CRITERION_LABELS[c] };
    views.forEach((v) => {
      row[v.short] = Number((v.row.perCriterion[c] ?? 0).toFixed(1));
    });
    return row;
  });
  return (
    <div className="rounded-2xl border border-border p-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Per-criterion (0–10)</div>
      <ResponsiveContainer width="100%" height={Math.max(240, views.length * 30 + 200)}>
        <RadarChart data={data} outerRadius="70%">
          <PolarGrid stroke="var(--border)" />
          <PolarAngleAxis dataKey="criterion" tick={{ fontSize: 11, fill: "var(--muted)" }} />
          {views.map((v) => (
            <Radar key={v.short} name={v.short} dataKey={v.short} stroke={v.color} fill={v.color} fillOpacity={0.12} strokeWidth={2} />
          ))}
          <Tooltip contentStyle={CHART_TOOLTIP} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Transposed comparison: metrics as rows, contenders as columns (like a scoreboard),
// horizontally scrollable when there are many contenders. Winner column highlighted.
function CompareTable({ views, percent, verifier }: { views: ContenderView[]; percent: boolean; verifier: boolean }) {
  const hasChecklist = !verifier && views.some((v) => v.pen.hasChecklist);
  const fmt = (n?: number) => (n === undefined ? "—" : percent ? fmtPct(n) : fmtScore(n));
  interface Row {
    label: string;
    strong?: boolean;
    better: "high" | "low";
    num: (v: ContenderView) => number | undefined;
    get: (v: ContenderView) => string;
  }
  const rows: Row[] = [];
  if (verifier) {
    rows.push({
      label: "Resolved",
      strong: true,
      better: "high",
      num: (v) => (v.row.resolved ? 1 : 0),
      get: (v) => (v.row.resolved ? "✓ pass" : "✗ fail"),
    });
    rows.push({
      label: "Hard checks",
      better: "high",
      num: (v) => (v.row.hardTotal ? (v.row.hardPassed ?? 0) / v.row.hardTotal : undefined),
      get: (v) => (v.row.hardTotal ? `${v.row.hardPassed ?? 0}/${v.row.hardTotal}` : "—"),
    });
    rows.push({ label: "Checks passed", better: "high", num: (v) => v.row.composite, get: (v) => fmtPct(v.row.composite) });
    if (views.some((v) => v.row.worstRep !== undefined)) {
      rows.push({ label: "Worst rep", better: "high", num: (v) => v.row.worstRep, get: (v) => fmtPct(v.row.worstRep) });
    }
  } else {
    rows.push({ label: "Overall score", strong: true, better: "high", num: (v) => v.row.composite, get: (v) => `${fmt(v.row.composite)} ± ${fmt(v.row.spread)}` });
    rows.push({ label: "Worst rep", better: "high", num: (v) => v.row.worstRep, get: (v) => fmt(v.row.worstRep) });
  }
  if (hasChecklist) {
    rows.push({ label: "Wrong claims", better: "low", num: (v) => v.pen.wrongClaims, get: (v) => String(v.pen.wrongClaims) });
    rows.push({ label: "Fabrications", better: "low", num: (v) => v.pen.fabrications, get: (v) => String(v.pen.fabrications) });
  }
  if (!percent) {
    for (const c of BENCH_CRITERIA) {
      rows.push({ label: BENCH_CRITERION_LABELS[c], better: "high", num: (v) => v.row.perCriterion[c], get: (v) => fmtScore(v.row.perCriterion[c]) });
    }
  }
  rows.push({ label: "Time", better: "low", num: (v) => v.result.elapsedMs, get: (v) => fmtMs(v.result.elapsedMs) });
  rows.push({ label: "Tokens", better: "low", num: (v) => v.result.usage?.total_tokens, get: (v) => fmtNum(v.result.usage?.total_tokens) });
  rows.push({ label: "≈5h cost", better: "low", num: (v) => totalSessionDelta(v.result.limitDelta), get: (v) => fmtLimitPct(totalSessionDelta(v.result.limitDelta)) });

  const bestOf = (row: Row): number => {
    let best = -1;
    let bestVal: number | undefined;
    views.forEach((v, i) => {
      const n = row.num(v);
      if (n === undefined || Number.isNaN(n) || n === 0) {
        if (!(row.label === "Wrong claims" || row.label === "Fabrications")) return;
      }
      if (n === undefined || Number.isNaN(n)) return;
      if (bestVal === undefined || (row.better === "high" ? n > bestVal : n < bestVal)) {
        bestVal = n;
        best = i;
      }
    });
    return best;
  };

  return (
    <div className="overflow-x-auto rounded-2xl border border-border">
      <table className="w-full border-collapse text-sm" style={{ minWidth: 300 + views.length * 180 }}>
        <thead>
          <tr className="border-b border-border">
            <th className="sticky left-0 z-10 bg-bg px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted">Metric</th>
            {views.map((v) => (
              <th key={v.rank} className={`min-w-[150px] px-4 py-3 text-left align-bottom ${v.rank === 0 ? "bg-subtle" : ""}`}>
                <div className="flex items-center gap-2">
                  {v.result.spec.kind === "mode" ? <ModeBadge mode={v.result.spec.mode} /> : <span className="font-semibold">{v.short}</span>}
                  {v.rank === 0 && <span title="Best overall">🥇</span>}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const best = views.length > 1 ? bestOf(row) : -1;
            return (
              <tr key={row.label} className="border-b border-border last:border-b-0">
                <th className="sticky left-0 z-10 bg-bg px-4 py-3 text-left font-medium text-muted">{row.label}</th>
                {views.map((v, i) => (
                  <td
                    key={v.rank}
                    className={`px-4 py-3 tabular-nums ${v.rank === 0 ? "bg-subtle" : ""} ${row.strong ? "text-base" : "text-sm"} ${i === best ? "font-semibold text-fg" : "text-muted"}`}
                  >
                    {row.get(v)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ResultsComparison({ run }: { run: BenchRun }) {
  const views = useMemo(() => contenderViews(run), [run]);
  const { copied, copy, download } = useCopyDownload();
  if (!views.length) return null;
  const { scoreSource, verifier, percent } = views[0];
  const showRadar = scoreSource === "rubric" && views.some((v) => BENCH_CRITERIA.some((c) => (v.row.perCriterion?.[c] ?? 0) > 0));
  const caption = verifier
    ? "Deterministic checks (pass@1) · 🥇 ✓ = resolved (all hard checks pass) · lower is better for time / tokens"
    : `${scoreSource === "checklist" ? "Checklist score (%)" : "Rubric score (0–10)"} · 🥇 = best overall · lower is better for claims / time / tokens`;
  const base = `fuse-bench-${run.config.taskId || "run"}-${run.id.slice(0, 8)}`;
  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold">Results</h3>
          <p className="mt-1 text-xs text-muted">{caption}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => copy(buildAnalysisMarkdown(run))}
            className="rounded-full border border-border px-3.5 py-1.5 text-sm transition hover:border-fg"
          >
            {copied ? "Copied ✓" : "Copy for AI"}
          </button>
          <button
            onClick={() => download(`${base}.md`, buildAnalysisMarkdown(run), "text/markdown")}
            className="rounded-full border border-border px-3.5 py-1.5 text-sm text-muted transition hover:border-fg hover:text-fg"
          >
            Save .md
          </button>
          <button
            onClick={() => download(`${base}.json`, JSON.stringify(buildAnalysisJson(run), null, 2), "application/json")}
            className="rounded-full border border-border px-3.5 py-1.5 text-sm text-muted transition hover:border-fg hover:text-fg"
          >
            Save .json
          </button>
        </div>
      </div>

      <div className={`mt-4 grid gap-3 ${showRadar ? "lg:grid-cols-2" : ""}`}>
        <ScoreChart views={views} percent={percent} verifier={verifier} />
        {showRadar && <CriteriaChart views={views} />}
      </div>

      <div className="mt-4">
        <CompareTable views={views} percent={percent} verifier={verifier} />
      </div>
    </section>
  );
}

function ResultDetails({ run, result, index }: { run: BenchRun; result: ContenderResult; index: number }) {
  const rationales = run.judgePasses
    .map((pass) => ({ pass, score: pass.scores.find((score) => score.resultIndex === index) }))
    .filter((x) => x.score || x.pass.error);
  return (
    <details className={`rounded-2xl border border-border p-4 ${result.status === "done" ? "" : "opacity-75"}`}>
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {result.spec.kind === "mode" && <ModeBadge mode={result.spec.mode} />}
            <span className="truncate font-medium">{resultLabel(result)}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted">{fmtMs(result.elapsedMs)}</span>
            <StatusChip status={result.status} />
          </div>
        </div>
      </summary>

      <div className="mt-4 border-t border-border pt-4">
        {result.error && <p className="mb-4 text-sm text-muted">{result.error}</p>}
        {result.limitDelta && (
          <p className="mb-4 text-sm text-muted">
            Limit cost: {fmtLimitPct(totalSessionDelta(result.limitDelta))} of 5h
            {result.limitDelta.approx ? " · approximate" : ""}
          </p>
        )}
        {result.final ? <Markdown>{result.final}</Markdown> : <p className="text-sm text-muted">No output yet.</p>}

        {result.usageItems && result.usageItems.length > 0 && (
          <div className="mt-6">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">Usage</div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="py-2">Role</th>
                    <th className="py-2">Model</th>
                    <th className="py-2 text-right">Input</th>
                    <th className="py-2 text-right">Output</th>
                    <th className="py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {result.usageItems.map((item, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="py-2 text-muted">{item.role}</td>
                      <td className="py-2">{item.provider}/{item.model}</td>
                      <td className="py-2 text-right text-muted">{fmtNum(item.prompt_tokens)}</td>
                      <td className="py-2 text-right text-muted">{fmtNum(item.completion_tokens)}</td>
                      <td className="py-2 text-right">{fmtNum(item.total_tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {rationales.length > 0 && (
          <div className="mt-6">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">Judge notes</div>
            <div className="mt-2 space-y-2">
              {rationales.map(({ pass, score }) => (
                <div key={`${pass.pass}-${pass.judgeIndex ?? 0}`} className="rounded-2xl bg-subtle p-3 text-sm">
                  <div className="font-medium">
                    Pass {pass.pass}
                    {pass.judge ? ` · ${modelLabel(pass.judge)}` : ""}
                  </div>
                  {pass.error ? (
                    <p className="mt-1 text-muted">{pass.error}</p>
                  ) : score ? (
                    <>
                      <p className="mt-1 text-muted">
                        {score.checklistScore !== undefined ? fmtPct(score.checklistScore) : fmtScore(score.composite)} ·{" "}
                        {score.rationale || "No rationale returned."}
                      </p>
                      {score.checklist?.length ? (
                        <div className="mt-2 grid gap-1 text-xs text-muted">
                          {score.checklist.map((item) => (
                            <div key={item.itemId} className="flex justify-between gap-3">
                              <span className="truncate">{item.itemId}</span>
                              <span className="uppercase">{item.verdict}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
