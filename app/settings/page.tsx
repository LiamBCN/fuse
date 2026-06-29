"use client";
import { useEffect, useState } from "react";
import { PROVIDERS, type ProviderMeta } from "@/lib/models";
import { loadConfig, saveConfig, DEFAULT_CONFIG, type FuseConfig } from "@/lib/settings";
import type { ModelRef } from "@/lib/types";

export default function SettingsPage() {
  const [cfg, setCfg] = useState<FuseConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [hasPicker, setHasPicker] = useState(false);

  useEffect(() => {
    loadConfig().then(setCfg);
    setHasPicker(typeof window !== "undefined" && !!(window as any).fuse?.chooseFolder);
  }, []);
  if (!cfg) return null;

  function update(next: FuseConfig) {
    setCfg(next);
    saveConfig(next);
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
    update({ ...cfg!, proposers: DEFAULT_CONFIG.proposers, aggregator: DEFAULT_CONFIG.aggregator });

  // Setting a folder here also turns on folder mode; clearing turns it off.
  const setWorkdir = (workdir: string) => update({ ...cfg!, workdir, folderMode: !!workdir });
  async function chooseFolder() {
    const dir = await (window as any).fuse?.chooseFolder?.();
    if (dir) setWorkdir(dir);
  }

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto px-6 py-12">
      <h1 className="text-4xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-3 text-lg text-muted">
        Fuse runs your locally-installed <span className="font-medium text-fg">Claude</span> and{" "}
        <span className="font-medium text-fg">Codex</span> CLIs via your subscription logins — no API
        keys, no metered cost.
      </p>

      <Section
        title="Working folder"
        subtitle="Optional. When set, the agents get full access to this folder — read, edit, and run commands — exactly like opening a terminal and running claude / codex inside it. Leave empty for plain chat with no file access."
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
        title="Agents"
        subtitle="These all answer in parallel. Pick a model per agent."
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

function ModelPicker({ value, onChange }: { value: ModelRef; onChange: (r: ModelRef) => void }) {
  const provider = PROVIDERS.find((p) => p.id === value.provider) ?? PROVIDERS[0];
  const listId = `models-${provider.id}`;
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
      {/* Editable: pick a suggested model or type any id the CLI accepts. */}
      <input
        value={value.model}
        list={listId}
        onChange={(e) => onChange({ ...value, model: e.target.value })}
        placeholder="model id"
        className="flex-1 rounded-2xl border border-border bg-subtle px-4 py-3 text-base outline-none focus:border-fg"
      />
      <datalist id={listId}>
        {provider.defaultModels.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}
