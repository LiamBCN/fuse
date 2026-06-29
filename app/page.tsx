"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Markdown from "@/components/Markdown";
import Logo from "@/components/Logo";
import { PROVIDERS } from "@/lib/models";
import { loadConfig, saveConfig, type FuseConfig } from "@/lib/settings";
import {
  loadConversation,
  saveConversation,
  loadActiveId,
  saveActiveId,
} from "@/lib/conversations";
import type { ImagePart, ModelRef, Turn } from "@/lib/types";

const mkey = (m: ModelRef) => `${m.provider}::${m.model}`;

// Shared style for every control above the composer (agent pills, selects,
// New chat) so they all match: small, rounded, bordered.
const CONTROL =
  "shrink-0 whitespace-nowrap rounded-full border border-border px-2.5 py-1 outline-none transition";

const folderName = (p: string) => p.replace(/\/+$/, "").split("/").filter(Boolean).pop() || p;

const newConvId = () => "conv-" + Math.floor(Math.random() * 1e9);
const dataUrl = (img: ImagePart) => `data:${img.mediaType};base64,${img.dataBase64}`;

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|jsx?|tsx?|py|rb|go|rs|java|kt|c|cpp|h|hpp|cs|php|swift|css|scss|html?|xml|sh|bash|zsh|sql|toml|ini|env|log)$/i;
const isTextual = (f: File) => f.type.startsWith("text/") || TEXT_EXT.test(f.name);

const readAs = (file: File, how: "dataURL" | "text") =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    how === "dataURL" ? r.readAsDataURL(file) : r.readAsText(file);
  });

export default function ChatPage() {
  const [cfg, setCfg] = useState<FuseConfig | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [pendImages, setPendImages] = useState<{ name: string; mediaType: string; dataBase64: string }[]>([]);
  const [pendFiles, setPendFiles] = useState<{ name: string; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openProposals, setOpenProposals] = useState<number | null>(null);
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());
  const convId = useRef<string>(newConvId());
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadConfig().then((c) => {
      setCfg(c);
      setActiveKeys(new Set(c.proposers.map(mkey))); // all configured agents on by default
    });

    // Stay on the same conversation across refreshes. Restore the last active
    // one if it still exists; otherwise start a fresh one and remember it.
    const active = loadActiveId();
    if (active) {
      loadConversation(active).then((restored) => {
        if (restored) {
          convId.current = restored.id;
          setTurns(restored.turns);
        } else {
          saveActiveId(convId.current);
        }
      });
    } else {
      saveActiveId(convId.current);
    }
  }, []);

  // Persist the conversation whenever it changes, so a refresh never loses it
  // and the History pages can read it back.
  useEffect(() => {
    if (turns.length === 0) return;
    saveConversation({ id: convId.current, turns });
  }, [turns]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  }, [input]);

  const hasAttachments = pendImages.length > 0 || pendFiles.length > 0;

  // Which agents actually run on this input (a toggleable subset of the config).
  const activeProposers = useMemo(
    () => (cfg ? cfg.proposers.filter((p) => activeKeys.has(mkey(p))) : []),
    [cfg, activeKeys],
  );

  // Candidate models for the "fuse with" picker: everything configured plus
  // each provider's defaults, de-duplicated.
  const aggOptions = useMemo<ModelRef[]>(() => {
    const out: ModelRef[] = [];
    const seen = new Set<string>();
    const add = (m: ModelRef) => {
      const k = mkey(m);
      if (!seen.has(k)) { seen.add(k); out.push(m); }
    };
    cfg?.proposers.forEach(add);
    if (cfg) add(cfg.aggregator);
    PROVIDERS.forEach((p) => p.defaultModels.forEach((model) => add({ provider: p.id, model })));
    return out;
  }, [cfg]);

  function toggleProposer(k: string) {
    setActiveKeys((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  }

  function setAggregator(m: ModelRef) {
    if (!cfg) return;
    const next = { ...cfg, aggregator: m };
    setCfg(next);
    saveConfig(next); // remember the chosen fuser across sessions
  }

  function setRounds(rounds: number) {
    if (!cfg) return;
    const next = { ...cfg, rounds };
    setCfg(next);
    saveConfig(next);
  }

  function patchCfg(patch: Partial<FuseConfig>) {
    if (!cfg) return;
    const next = { ...cfg, ...patch };
    setCfg(next);
    saveConfig(next);
  }

  // Toggle between plain chat and full folder access (remembering the folder).
  function setFolderMode(on: boolean) {
    if (!cfg) return;
    if (on && !cfg.workdir) return pickFolder();
    patchCfg({ folderMode: on && !!cfg.workdir });
  }

  // Pick a folder for full agent access: native dialog in the app, prompt in a browser.
  async function pickFolder() {
    const api = (typeof window !== "undefined" ? (window as any).fuse : null) as
      | { chooseFolder?: () => Promise<string | null> }
      | null;
    const dir = api?.chooseFolder
      ? await api.chooseFolder()
      : window.prompt("Folder path for full agent access:", cfg?.workdir || "");
    if (dir) patchCfg({ workdir: dir, folderMode: true });
  }

  async function addFiles(list: FileList | File[]) {
    for (const file of Array.from(list)) {
      try {
        if (file.type.startsWith("image/")) {
          const url = await readAs(file, "dataURL");
          setPendImages((p) => [...p, { name: file.name, mediaType: file.type, dataBase64: url.split(",")[1] ?? "" }]);
        } else if (isTextual(file)) {
          const text = await readAs(file, "text");
          setPendFiles((p) => [...p, { name: file.name, text }]);
        } else {
          setError(`Unsupported file type: ${file.name}`);
        }
      } catch {
        setError(`Could not read ${file.name}`);
      }
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (imgs.length) {
      e.preventDefault();
      addFiles(imgs);
    }
  }

  async function send() {
    if ((!input.trim() && !hasAttachments) || busy || !cfg) return;
    if (activeProposers.length === 0) {
      setError("Select at least one agent to ask.");
      return;
    }
    setError(null);

    const fileText = pendFiles.map((f) => `\n\n--- ${f.name} ---\n\`\`\`\n${f.text}\n\`\`\``).join("");
    const images: ImagePart[] = pendImages.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 }));
    const userTurn: Turn = {
      role: "user",
      content: input.trim(),
      images: images.length ? images : undefined,
      files: pendFiles.length ? pendFiles.map((f) => f.name) : undefined,
      fileText: fileText || undefined,
    };

    const history = [...turns, userTurn];
    setTurns(history);
    setInput("");
    setPendImages([]);
    setPendFiles([]);
    setBusy(true);

    const messages = history.map((t) => ({
      role: t.role,
      content: t.content + (t.fileText ?? ""),
      images: t.images,
    }));
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages,
          proposers: activeProposers,
          aggregator: cfg.aggregator,
          conversationId: convId.current,
          rounds: cfg.rounds,
          workdir: cfg.folderMode ? cfg.workdir : "",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      setTurns((t) => [...t, { role: "assistant", content: data.final, proposals: data.proposals }]);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function newChat() {
    setTurns([]);
    setError(null);
    setOpenProposals(null);
    setPendImages([]);
    setPendFiles([]);
    convId.current = newConvId();
    saveActiveId(convId.current); // keep refreshes pinned to the new chat
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-6">
      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto pb-10 pt-7">
        {turns.length === 0 ? (
          <div className="mx-auto mt-16 max-w-xl text-center">
            <h1
              className="bg-gradient-to-r from-red-600 to-amber-500 bg-clip-text font-bold tracking-tight text-transparent dark:from-red-300 dark:to-amber-200"
              style={{ fontSize: "4.2rem", lineHeight: 1.05 }}
            >
              Ask once.<br />Multiple agents. <br />One fuses.
            </h1>
          </div>
        ) : (
          <div className="space-y-10">
            {turns.map((t, i) => (
              <Message
                key={i}
                turn={t}
                convId={convId.current}
                index={i}
                open={openProposals === i}
                onToggle={() => setOpenProposals(openProposals === i ? null : i)}
              />
            ))}
          </div>
        )}

        {busy && (
          <div className="mt-10 flex items-center gap-4">
            <Avatar role="assistant" />
            <span className="flex gap-1.5">
              <Dot /><Dot delay="150ms" /><Dot delay="300ms" />
            </span>
          </div>
        )}
        {error && <div className="mt-10 rounded-2xl border border-border bg-subtle p-5">{error}</div>}
      </div>

      {/* Chat / Folder switch — when a folder is selected, its name shows here */}
      {cfg && (
        <div className="flex items-center gap-2 pt-2 text-xs">
          <div className="inline-flex items-center rounded-full border border-border p-0.5">
            <button
              onClick={() => setFolderMode(false)}
              title="Plain chat — agents have no file access"
              className={`rounded-full px-3 py-1 transition ${
                !cfg.folderMode ? "bg-fg text-bg" : "text-muted hover:text-fg"
              }`}
            >
              Chat
            </button>
            <button
              onClick={() => (cfg.folderMode ? pickFolder() : setFolderMode(true))}
              title={
                cfg.workdir
                  ? `Full access: ${cfg.workdir}\nClick to change folder`
                  : "Pick a folder for full read/edit/run access"
              }
              className={`flex max-w-[18rem] items-center gap-1.5 truncate rounded-full px-3 py-1 transition ${
                cfg.folderMode ? "bg-fg text-bg" : "text-muted hover:text-fg"
              }`}
            >
              📁 <span className="truncate">{cfg.folderMode && cfg.workdir ? folderName(cfg.workdir) : "Folder"}</span>
            </button>
          </div>
        </div>
      )}

      {/* Controls — one consistent pill style: agents scroll, controls stay fixed */}
      {cfg && (
        <div className="flex items-center gap-2 pt-2 text-xs">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
            <span className="shrink-0 text-muted" title="The models that each answer your question in parallel. Click to toggle.">
              Agents
            </span>
            {cfg.proposers.length === 0 && (
              <Link href="/settings" className={`${CONTROL} text-muted hover:text-fg`}>add models</Link>
            )}
            {cfg.proposers.map((p, i) => {
              const k = mkey(p);
              const on = activeKeys.has(k);
              return (
                <button
                  key={i}
                  onClick={() => toggleProposer(k)}
                  title={`${p.provider}/${p.model}`}
                  className={`${CONTROL} ${on ? "!border-fg bg-fg text-bg" : "text-muted hover:text-fg"}`}
                >
                  {p.model}
                </button>
              );
            })}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-muted" title="How hard the agents think — extra rounds where they refine using each other's answers before fusing.">
              Depth
            </span>
            <select
              value={String(cfg.rounds)}
              onChange={(e) => setRounds(Number(e.target.value))}
              title="Reasoning depth — extra refinement rounds where agents see each other's answers before the final fuse"
              className={`${CONTROL} cursor-pointer bg-transparent text-fg hover:border-fg`}
            >
              <option value="1">Standard</option>
              <option value="2">Advanced</option>
              <option value="3">Deep</option>
            </select>
            <span className="text-muted" title="The model that reads every agent's answer and writes the final, fused reply.">
              Fuse with
            </span>
            <select
              value={String(aggOptions.findIndex((m) => mkey(m) === mkey(cfg.aggregator)))}
              onChange={(e) => setAggregator(aggOptions[Number(e.target.value)])}
              title="Model that fuses all answers"
              className={`${CONTROL} max-w-[10rem] cursor-pointer bg-transparent text-fg hover:border-fg`}
            >
              {PROVIDERS.map((prov) => {
                const opts = aggOptions
                  .map((m, idx) => ({ m, idx }))
                  .filter(({ m }) => m.provider === prov.id);
                if (!opts.length) return null;
                return (
                  <optgroup key={prov.id} label={prov.label}>
                    {opts.map(({ m, idx }) => (
                      <option key={idx} value={String(idx)}>{m.model}</option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
            {turns.length > 0 && (
              <button onClick={newChat} className={`${CONTROL} text-muted hover:text-fg`}>New chat</button>
            )}
          </div>
        </div>
      )}

      {/* Composer */}
      <div className="pb-6 pt-2">
        <div className="rounded-3xl border border-border bg-subtle p-3 focus-within:border-fg">
          {hasAttachments && (
            <div className="mb-2 flex flex-wrap gap-2 px-1">
              {pendImages.map((img, i) => (
                <div key={"i" + i} className="group relative">
                  <img src={`data:${img.mediaType};base64,${img.dataBase64}`} alt={img.name} className="h-16 w-16 rounded-xl border border-border object-cover" />
                  <button
                    onClick={() => setPendImages((p) => p.filter((_, j) => j !== i))}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-fg text-xs text-bg"
                    aria-label="Remove image"
                  >×</button>
                </div>
              ))}
              {pendFiles.map((f, i) => (
                <span key={"f" + i} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm">
                  📄 {f.name}
                  <button onClick={() => setPendFiles((p) => p.filter((_, j) => j !== i))} aria-label="Remove file">×</button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <button
              onClick={() => fileRef.current?.click()}
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-bg hover:text-fg"
              aria-label="Attach files"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              rows={1}
              placeholder="Ask all your models…"
              className="max-h-60 flex-1 resize-none bg-transparent px-2 py-3 text-base outline-none placeholder:text-muted"
            />
            <button
              onClick={send}
              disabled={busy || (!input.trim() && !hasAttachments)}
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-fg text-bg transition hover:opacity-80 disabled:opacity-30"
              aria-label="Send"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Message({
  turn,
  convId,
  index,
  open,
  onToggle,
}: {
  turn: Turn;
  convId: string;
  index: number;
  open: boolean;
  onToggle: () => void;
}) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end gap-4">
        <div className="max-w-[80%]">
          {(turn.images?.length || turn.files?.length) && (
            <div className="mb-2 flex flex-wrap justify-end gap-2">
              {turn.images?.map((img, i) => (
                <img key={i} src={dataUrl(img)} alt="" className="h-24 w-24 rounded-xl border border-border object-cover" />
              ))}
              {turn.files?.map((name, i) => (
                <span key={i} className="rounded-xl border border-border px-3 py-2 text-sm">📄 {name}</span>
              ))}
            </div>
          )}
          {turn.content && (
            <div className="whitespace-pre-wrap rounded-3xl rounded-tr-md bg-fg px-5 py-3.5 text-base text-bg">
              {turn.content}
            </div>
          )}
        </div>
        <Avatar role="user" />
      </div>
    );
  }
  return (
    <div className="flex gap-4">
      <Avatar role="assistant" />
      <div className="min-w-0 flex-1">
        <Markdown>{turn.content}</Markdown>
        {turn.proposals && turn.proposals.length > 0 && (
          <div className="mt-3 flex items-center gap-4 text-sm">
            <button onClick={onToggle} className="text-muted underline hover:text-fg">
              {open ? "Hide" : "Show"} {turn.proposals.length} model proposals
            </button>
            <Link
              href={`/history/${convId}#turn-${index}`}
              className="text-muted underline hover:text-fg"
              title="Open this answer in the history & debug view"
            >
              Debug ↗
            </Link>
          </div>
        )}
        {open && turn.proposals && (
          <div className="mt-4 space-y-3">
            {turn.proposals.map((p, j) => (
              <details key={j} className="rounded-2xl border border-border p-4" open>
                <summary className="cursor-pointer text-sm font-medium text-muted">
                  {p.provider}/{p.model}{p.error ? " — error" : ""}
                </summary>
                <div className="mt-3">
                  {p.error ? <p className="text-muted">{p.error}</p> : <Markdown>{p.content}</Markdown>}
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Avatar({ role }: { role: "user" | "assistant" }) {
  if (role === "assistant") return <Logo className="h-10 w-10 shrink-0" />;
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border text-sm font-semibold">
      You
    </div>
  );
}

function Dot({ delay = "0ms" }: { delay?: string }) {
  return <span className="h-2 w-2 animate-bounce rounded-full bg-muted" style={{ animationDelay: delay }} />;
}
