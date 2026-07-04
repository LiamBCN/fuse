"use client";
import { useEffect, useState } from "react";
import { PROVIDERS } from "@/lib/models";
import { loadConfig, saveConfig, DEFAULT_CONFIG, type FuseConfig } from "@/lib/settings";
import type { Effort, ModelRef, StageKey } from "@/lib/types";

const EFFORT_LEVELS: { key: Effort; label: string; hint: string }[] = [
  { key: "low", label: "Low", hint: "Fastest, least reasoning" },
  { key: "medium", label: "Medium", hint: "Balanced" },
  { key: "high", label: "High", hint: "Most thorough, slower" },
];

const PLAN_STAGES: { key: StageKey; label: string; role: "A" | "B" | "Aggregator" }[] = [
  { key: "clarify", label: "Clarify", role: "A" },
  { key: "recon", label: "Recon", role: "Aggregator" },
  { key: "draftA", label: "Draft A", role: "A" },
  { key: "draftB", label: "Draft B", role: "B" },
  { key: "harden", label: "Harden", role: "B" },
  { key: "verify", label: "Verify", role: "Aggregator" },
  { key: "synthesize", label: "Synthesize", role: "Aggregator" },
  { key: "finalize", label: "Finalize", role: "Aggregator" },
];

const sameModel = (a: ModelRef, b: ModelRef) => a.provider === b.provider && a.model === b.model;

function normalizeClaudeToken(input: string): string {
  return input
    .trim()
    .replace(/^export\s+/, "")
    .replace(/^CLAUDE_CODE_OAUTH_TOKEN=/, "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function roleDefault(cfg: FuseConfig, key: StageKey): ModelRef {
  const a = cfg.proposers[0] ?? DEFAULT_CONFIG.proposers[0];
  const b = cfg.proposers[1] ?? a;
  if (key === "draftB" || key === "harden") return b;
  if (key === "recon" || key === "verify" || key === "synthesize" || key === "finalize") return cfg.aggregator;
  return a;
}

export default function SettingsPage() {
  const [cfg, setCfg] = useState<FuseConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [hasPicker, setHasPicker] = useState(false);
  const [notifPerm, setNotifPerm] = useState<string>("default");
  const [tokenDraft, setTokenDraft] = useState("");

  useEffect(() => {
    loadConfig().then(setCfg);
    setHasPicker(typeof window !== "undefined" && !!(window as any).fuse?.chooseFolder);
    if (typeof Notification !== "undefined") setNotifPerm(Notification.permission);
  }, []);
  if (!cfg) return null;

  async function enableNotifications() {
    if (typeof Notification === "undefined") return;
    const p = await Notification.requestPermission();
    setNotifPerm(p);
  }

  function update(next: FuseConfig) {
    setCfg(next);
    saveConfig(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  }

  async function saveClaudeToken(clear = false) {
    const token = clear ? "" : normalizeClaudeToken(tokenDraft);
    if (!clear && !token) return;
    const next: FuseConfig = { ...cfg!, claudeOauthToken: token, claudeOauthTokenSet: !clear };
    await saveConfig(next);
    setCfg({ ...cfg!, claudeOauthToken: undefined, claudeOauthTokenSet: !clear });
    setTokenDraft("");
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  }

  function setProposer(i: number, ref: ModelRef) {
    const proposers = [...cfg!.proposers];
    proposers[i] = ref;
    update({ ...cfg!, proposers });
  }
  const addProposer = () => {
    const p = PROVIDERS[0];
    update({ ...cfg!, proposers: [...cfg!.proposers, { provider: p.id, model: p.defaultModels[0] }] });
  };
  const removeProposer = (i: number) => update({ ...cfg!, proposers: cfg!.proposers.filter((_, j) => j !== i) });
  const resetModels = () =>
    update({ ...cfg!, proposers: DEFAULT_CONFIG.proposers, aggregator: DEFAULT_CONFIG.aggregator, stageModels: {} });

  function setStageModel(key: StageKey, ref?: ModelRef) {
    const stageModels = { ...(cfg!.stageModels ?? {}) };
    if (ref) stageModels[key] = ref;
    else delete stageModels[key];
    update({ ...cfg!, stageModels });
  }

  // Setting a folder here also turns on folder mode; clearing turns it off.
  const setWorkdir = (workdir: string) => update({ ...cfg!, workdir, folderMode: !!workdir });
  async function chooseFolder() {
    const dir = await (window as any).fuse?.chooseFolder?.();
    if (dir) setWorkdir(dir);
  }

  const reconResolved = (["recon", "verify", "synthesize"] as StageKey[]).map((key) => cfg.stageModels?.[key] ?? roleDefault(cfg, key));
  const reconChainMismatch = !sameModel(reconResolved[0], reconResolved[1]) || !sameModel(reconResolved[0], reconResolved[2]);

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto px-6 py-12">
      <h1 className="text-4xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-3 text-lg text-muted">
        Fuse runs your locally-installed <span className="font-medium text-fg">Claude</span> and{" "}
        <span className="font-medium text-fg">Codex</span> CLIs via your subscription logins - no API
        keys, no metered cost.
      </p>

      <Section
        title="Working folder"
        subtitle="Optional. When set, the agents get full access to this folder - read, edit, and run commands - exactly like opening a terminal and running claude / codex inside it. Leave empty for plain chat with no file access."
      >
        <div className="flex gap-3">
          <input
            value={cfg.workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            placeholder="/Users/you/projects/your-app"
            spellCheck={false}
            className="flex-1 rounded-2xl border border-border bg-subtle px-4 py-3 text-base outline-none focus:border-fg"
          />
          {hasPicker && (
            <button
              onClick={chooseFolder}
              className="shrink-0 rounded-2xl border border-border px-4 text-base hover:border-fg"
            >
              Choose…
            </button>
          )}
          {cfg.workdir && (
            <button
              onClick={() => setWorkdir("")}
              className="shrink-0 rounded-2xl border border-border px-4 text-base text-muted hover:text-fg"
            >
              Clear
            </button>
          )}
        </div>
        {cfg.workdir && (
          <p className="mt-3 text-sm text-muted">
            ⚠︎ Agents can modify files and run commands in this folder. Point it only at a project you
            trust them to change.
          </p>
        )}
      </Section>

      <Section
        title="Claude auth"
        subtitle="For Fuse.app and other non-interactive launches, run `claude setup-token` in a logged-in terminal and paste the emitted OAuth token here. It uses your Claude subscription and is never shown again after saving."
      >
        <div className="flex gap-3">
          <input
            type="password"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            placeholder={cfg.claudeOauthTokenSet ? "Token saved" : "CLAUDE_CODE_OAUTH_TOKEN=..."}
            spellCheck={false}
            className="flex-1 rounded-2xl border border-border bg-subtle px-4 py-3 text-base outline-none focus:border-fg"
          />
          <button
            onClick={() => saveClaudeToken(false)}
            disabled={!normalizeClaudeToken(tokenDraft)}
            className="shrink-0 rounded-2xl border border-border px-4 text-base hover:border-fg disabled:opacity-30"
          >
            Save
          </button>
          {cfg.claudeOauthTokenSet && (
            <button
              onClick={() => saveClaudeToken(true)}
              className="shrink-0 rounded-2xl border border-border px-4 text-base text-muted hover:text-fg"
            >
              Clear
            </button>
          )}
        </div>
        <p className="mt-3 text-sm text-muted">
          Status: {cfg.claudeOauthTokenSet ? "token configured" : "no token saved"}
        </p>
      </Section>

      <Section
        title="Agents"
        subtitle="These all answer in parallel. Pick a model per agent - or type your own. Exact Claude ids keep runs deterministic; aliases like sonnet/opus still work if you want provider defaults."
        action={
          <div className="flex items-center gap-4">
            <button onClick={resetModels} className="text-base text-muted underline hover:text-fg">Reset</button>
            <button onClick={addProposer} className="text-base underline hover:text-muted">+ Add</button>
          </div>
        }
      >
        <div className="space-y-3">
          {cfg.proposers.map((p, i) => (
            <div key={i} className="flex gap-3">
              <ModelPicker value={p} onChange={(r) => setProposer(i, r)} />
              <button
                onClick={() => removeProposer(i)}
                disabled={cfg.proposers.length === 1}
                className="rounded-2xl border border-border px-4 text-muted hover:text-fg disabled:opacity-30"
                aria-label="Remove"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Aggregator" subtitle="Reads every agent's answer and writes the final fused reply.">
        <ModelPicker value={cfg.aggregator} onChange={(r) => update({ ...cfg, aggregator: r })} />
      </Section>

      <Section
        title="Effort"
        subtitle="Reasoning effort applied to every model call - both Claude (--effort) and Codex (model_reasoning_effort). Higher is more thorough but slower. This is the default for all runs."
      >
        <div className="flex gap-3">
          {EFFORT_LEVELS.map((level) => {
            const active = cfg.effort === level.key;
            return (
              <button
                key={level.key}
                onClick={() => update({ ...cfg, effort: level.key })}
                aria-pressed={active}
                className={`flex-1 rounded-2xl border px-4 py-3 text-center transition ${
                  active ? "border-fg bg-fg text-bg" : "border-border text-fg hover:border-fg"
                }`}
              >
                <div className="text-base font-medium">{level.label}</div>
                <div className={`mt-0.5 text-sm ${active ? "text-bg/70" : "text-muted"}`}>{level.hint}</div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section
        title="Plan stages"
        subtitle="Optional overrides for folder-backed plan runs. A stage uses its role default unless you turn on an override here."
      >
        {reconChainMismatch && (
          <p className="mb-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            Recon, Verify, and Synthesize do not share the same model. Fuse will run them as fresh stages instead of resuming one Claude session.
          </p>
        )}
        <div className="space-y-3">
          {PLAN_STAGES.map((stage) => {
            const fallback = roleDefault(cfg, stage.key);
            const override = cfg.stageModels?.[stage.key];
            const enabled = !!override;
            return (
              <div key={stage.key} className="rounded-2xl border border-border bg-subtle p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">{stage.label}</div>
                    <div className="text-sm text-muted">
                      Default: {stage.role} · {fallback.provider}/{fallback.model}
                    </div>
                  </div>
                  <label className="flex shrink-0 items-center gap-2 text-sm text-muted">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => setStageModel(stage.key, e.target.checked ? fallback : undefined)}
                    />
                    Override
                  </label>
                </div>
                {enabled && (
                  <ModelPicker
                    value={override ?? fallback}
                    onChange={(r) => setStageModel(stage.key, r)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Notifications" subtitle="Play a sound + show a desktop alert when an agent needs input, or when a long task finishes while Fuse isn't focused.">
        <div className="flex items-center justify-between gap-4">
          <button
            onClick={() => update({ ...cfg, notifications: !cfg.notifications })}
            role="switch"
            aria-checked={cfg.notifications}
            className={`relative h-7 w-12 shrink-0 rounded-full transition ${cfg.notifications ? "bg-fg" : "bg-border"}`}
          >
            <span
              className={`absolute top-1 h-5 w-5 rounded-full bg-bg transition-all ${cfg.notifications ? "left-6" : "left-1"}`}
            />
          </button>
          <span className="flex-1 text-base">{cfg.notifications ? "Notifications on" : "Notifications off"}</span>
          {notifPerm === "granted" ? (
            <span className="text-sm text-muted">macOS: allowed</span>
          ) : notifPerm === "denied" ? (
            <span className="text-right text-sm text-muted">Blocked - enable in System&nbsp;Settings ▸ Notifications ▸ Fuse</span>
          ) : (
            <button onClick={enableNotifications} className="rounded-full border border-border px-4 py-2 text-sm hover:border-fg">
              Allow…
            </button>
          )}
        </div>
      </Section>

      <Section
        title="Benchmarks"
        subtitle="Publish finished benchmark runs into a local Fuse clone (git), so results are versioned and everyone who pulls sees them in History. Leave empty in dev to use this checkout."
      >
        <div className="flex gap-3">
          <input
            value={cfg.benchResultsRepo ?? ""}
            onChange={(e) => update({ ...cfg, benchResultsRepo: e.target.value })}
            placeholder="/Users/you/projects/fuse"
            spellCheck={false}
            className="flex-1 rounded-2xl border border-border bg-subtle px-4 py-3 text-base outline-none focus:border-fg"
          />
          {hasPicker && (
            <button
              onClick={async () => {
                const dir = await (window as any).fuse?.chooseFolder?.();
                if (dir) update({ ...cfg!, benchResultsRepo: dir });
              }}
              className="shrink-0 rounded-2xl border border-border px-4 text-base hover:border-fg"
            >
              Choose…
            </button>
          )}
        </div>
        <div className="mt-4 flex items-center justify-between gap-4">
          <button
            onClick={() => update({ ...cfg, benchAutoPublish: !cfg.benchAutoPublish })}
            role="switch"
            aria-checked={!!cfg.benchAutoPublish}
            className={`relative h-7 w-12 shrink-0 rounded-full transition ${cfg.benchAutoPublish ? "bg-fg" : "bg-border"}`}
          >
            <span
              className={`absolute top-1 h-5 w-5 rounded-full bg-bg transition-all ${cfg.benchAutoPublish ? "left-6" : "left-1"}`}
            />
          </button>
          <span className="flex-1 text-base">
            {cfg.benchAutoPublish ? "Auto-publish finished runs" : "Auto-publish off"}
          </span>
        </div>
      </Section>

      <Section title="About" subtitle="Fuse is open source.">
        <a
          href="https://github.com/LiamBCN/fuse"
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-2.5 rounded-2xl border border-border px-4 py-3 text-base transition hover:border-fg"
        >
          <GitHubIcon />
          View on GitHub
          <span className="text-sm text-muted">LiamBCN/fuse</span>
        </a>
      </Section>

      <div className="h-12" />
      {saved && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-fg px-5 py-2 text-base text-bg shadow-lg">
          Saved
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-12 border-t border-border pt-8">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-2xl font-semibold">{title}</h2>
        {action}
      </div>
      {subtitle && <p className="mb-4 -mt-2 text-base text-muted">{subtitle}</p>}
      {children}
    </section>
  );
}

function GitHubIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.3-1.7-1.3-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z" />
    </svg>
  );
}

function ModelPicker({ value, onChange }: { value: ModelRef; onChange: (r: ModelRef) => void }) {
  const provider = PROVIDERS.find((p) => p.id === value.provider) ?? PROVIDERS[0];
  const custom = !provider.defaultModels.includes(value.model);
  const modelSelectValue = custom ? "__custom__" : value.model;
  return (
    <div className="flex flex-1 gap-3">
      <select
        value={provider.id}
        onChange={(e) => {
          const next = PROVIDERS.find((p) => p.id === e.target.value)!;
          onChange({ provider: next.id, model: next.defaultModels[0] });
        }}
        className="rounded-2xl border border-border bg-subtle px-3 py-3 text-base outline-none focus:border-fg"
      >
        {PROVIDERS.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      <select
        value={modelSelectValue}
        onChange={(e) => {
          const model = e.target.value;
          onChange({ ...value, model: model === "__custom__" ? "" : model });
        }}
        className="min-w-0 flex-1 rounded-2xl border border-border bg-subtle px-4 py-3 text-base outline-none focus:border-fg"
      >
        {provider.defaultModels.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value="__custom__">Custom model id…</option>
      </select>
      {(custom || value.model === "") && (
        <input
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
          placeholder="custom model id"
          className="min-w-0 flex-1 rounded-2xl border border-border bg-subtle px-4 py-3 text-base outline-none focus:border-fg"
        />
      )}
    </div>
  );
}
