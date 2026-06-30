"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { clearRun, getRun, runsVersion, startRun, subscribeRuns } from "@/lib/chat-runtime";
import type { ImagePart, Mode, ModelRef, Turn } from "@/lib/types";

const mkey = (m: ModelRef) => `${m.provider}::${m.model}`;

// Shared style for every control above the composer (agent pills, selects,
// New chat) so they all match: small, rounded, bordered.
const CONTROL =
  "shrink-0 whitespace-nowrap rounded-full border border-border px-2.5 py-1 outline-none transition";

const folderName = (p: string) => p.replace(/\/+$/, "").split("/").filter(Boolean).pop() || p;

const fmtElapsed = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);
const CONTEXT_TOKENS = 200_000; // Claude context window (approx)

// How the agents work. Normal = a fused answer; Attack/Relay run a planning
// pipeline and save a plan.md (hover shows the diagram).
const MODE_OPTIONS: { value: Mode; label: string; blurb: string; img?: string }[] = [
  {
    value: "normal",
    label: "Normal",
    blurb: "Each agent answers and the strongest model fuses them into one reply. No plan file.",
    img: "/plan-normal.png",
  },
  {
    value: "attack",
    label: "Attack",
    blurb: "Both agents draft a plan, then each attacks the other's to expose risks. The strongest model merges them into one plan.md.",
    img: "/plan-attack.png",
  },
  {
    value: "relay",
    label: "Relay",
    blurb: "One agent drafts, the other hardens it, then the strongest model finalizes - a deeper hand-off. Saves plan.md.",
    img: "/plan-relay.png",
  },
];

const newConvId = () => "conv-" + Math.floor(Math.random() * 1e9);

// Plan-file card helpers: the filename and a "Document · MD" style type label.
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const fileKind = (p: string) => {
  const ext = (p.split(".").pop() || "").toUpperCase();
  return ext && ext !== p.toUpperCase() ? `Document · ${ext}` : "Document";
};
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
  const [elapsed, setElapsed] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openProposals, setOpenProposals] = useState<number | null>(null);
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planHover, setPlanHover] = useState<Mode | null>(null);
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [clarify, setClarify] = useState<{ questions: string[] } | null>(null);
  const [clarifyAnswer, setClarifyAnswer] = useState("");
  const convId = useRef<string>(newConvId());
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const agentsRef = useRef<HTMLDivElement>(null);
  const planRef = useRef<HTMLDivElement>(null);
  const folderRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<any>(null);
  const voiceCleanupRef = useRef<null | (() => void)>(null);

  // Generation lives in the app-level runtime (lib/chat-runtime), so it keeps
  // going when you leave this page and multiple chats can run at once. Subscribe
  // so this page re-renders as the active conversation's run progresses, and
  // derive busy/progress from that run instead of local state.
  const runsTick = useSyncExternalStore(subscribeRuns, runsVersion, runsVersion);
  const activeRun = getRun(convId.current);
  const busy = activeRun?.status === "running";
  const progress = activeRun?.progress ?? null;

  // Apply a finished run for `id` (its assistant turn is already persisted by the
  // runtime): refresh the transcript and surface a clarification / error, then
  // drop the record. No-op while the run is still in flight; safe to call again.
  const reconcileRun = (id: string) => {
    const run = getRun(id);
    if (!run || run.status === "running") return;
    if (run.status === "error") {
      setError(run.error ?? "Request failed");
      clearRun(id);
      return;
    }
    loadConversation(id).then((c) => {
      if (c && convId.current === id) setTurns(c.turns);
    });
    if (run.clarify) {
      setClarifyAnswer("");
      setClarify({ questions: run.clarify.questions });
    }
    clearRun(id);
  };

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
          // It may have finished (or errored) while this page was unmounted.
          reconcileRun(restored.id);
        } else {
          saveActiveId(convId.current);
        }
      });
    } else {
      saveActiveId(convId.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the conversation whenever it changes, so a refresh never loses it
  // and the History pages can read it back.
  useEffect(() => {
    if (turns.length === 0) return;
    saveConversation({ id: convId.current, turns });
  }, [turns]);

  // React to the active conversation's run finishing (including while we were on
  // another page) - pull the persisted reply, or show its clarify/error.
  useEffect(() => {
    reconcileRun(convId.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsTick]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy, progress]);
  // Count seconds while a response is generating, so the user sees it's alive -
  // measured from when the run actually started (survives navigating away/back).
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const startedAt = activeRun?.startedAt ?? Date.now();
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [busy, activeRun?.startedAt]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  }, [input]);
  // Ask for notification permission once on open.
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);
  useEffect(() => {
    if (!agentsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (agentsRef.current && !agentsRef.current.contains(e.target as Node)) setAgentsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [agentsOpen]);
  useEffect(() => {
    if (!planOpen) return;
    const onDown = (e: MouseEvent) => {
      if (planRef.current && !planRef.current.contains(e.target as Node)) setPlanOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [planOpen]);
  useEffect(() => {
    if (!folderMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (folderRef.current && !folderRef.current.contains(e.target as Node)) setFolderMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [folderMenuOpen]);
  useEffect(() => {
    if (!ctxOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ctxOpen]);

  const hasAttachments = pendImages.length > 0 || pendFiles.length > 0;

  // Rough estimate of how much of the model's context window this conversation uses.
  const usedTokens = useMemo(() => {
    let chars = input.length + pendFiles.reduce((s, f) => s + f.text.length, 0);
    for (const t of turns) chars += (t.content?.length ?? 0) + (t.fileText?.length ?? 0);
    return Math.ceil(chars / 4);
  }, [turns, input, pendFiles]);
  const pctUsed = Math.min(100, Math.round((usedTokens / CONTEXT_TOKENS) * 100));

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

  function setMode(mode: Mode) {
    if (!cfg) return;
    const next = { ...cfg, mode };
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

  // Activate a folder and move it to the top of the recents list. Folders are
  // for planning, so switch out of Normal into a plan pipeline (Attack).
  function selectFolder(dir: string) {
    if (!cfg) return;
    const recentFolders = [dir, ...cfg.recentFolders.filter((x) => x !== dir)].slice(0, 12);
    const mode: Mode = cfg.mode === "normal" ? "attack" : cfg.mode;
    patchCfg({ workdir: dir, folderMode: true, mode, recentFolders });
    setFolderMenuOpen(false);
  }
  function removeRecent(dir: string) {
    if (!cfg) return;
    patchCfg({ recentFolders: cfg.recentFolders.filter((x) => x !== dir) });
  }

  // Pick a NEW folder: native dialog in the app, prompt in a browser.
  async function pickFolder() {
    const api = (typeof window !== "undefined" ? (window as any).fuse : null) as
      | { chooseFolder?: () => Promise<string | null> }
      | null;
    const dir = api?.chooseFolder
      ? await api.chooseFolder()
      : window.prompt("Folder path for full agent access:", cfg?.workdir || "");
    if (dir) selectFolder(dir);
    setFolderMenuOpen(false);
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

  function stopMic() {
    const api = typeof window !== "undefined" ? (window as any).fuse : null;
    api?.voiceStop?.();
    recRef.current?.stop?.();
    voiceCleanupRef.current?.();
    voiceCleanupRef.current = null;
    setRecording(false);
  }

  // Voice input: prefer the bundled on-device macOS helper; fall back to the
  // browser speech API (dev/web), else hint about macOS Dictation.
  function toggleMic() {
    if (recording) {
      stopMic();
      return;
    }
    const api = typeof window !== "undefined" ? (window as any).fuse : null;
    if (api?.voiceStart) {
      voiceCleanupRef.current?.(); // drop any lingering listener so it can't clobber text
      const base = input ? input.trimEnd() + " " : "";
      let offText: undefined | (() => void);
      let offErr: undefined | (() => void);
      const cleanup = () => {
        offText?.();
        offErr?.();
      };
      offText = api.onVoiceText?.((t: string) => setInput((base + t).replace(/\s+/g, " ")));
      offErr = api.onVoiceError?.((e: string) => {
        setError(e || "Voice input failed.");
        setRecording(false);
        cleanup();
        voiceCleanupRef.current = null;
      });
      voiceCleanupRef.current = cleanup;
      setError(null);
      setRecording(true);
      api.voiceStart();
      return;
    }

    const SR = (typeof window !== "undefined" && ((window as any).webkitSpeechRecognition || (window as any).SpeechRecognition)) as any;
    if (!SR) {
      setError("Voice input isn't available here. Use macOS Dictation (press your Dictation key, e.g. Fn Fn) to speak into the box.");
      taRef.current?.focus();
      return;
    }
    try {
      const rec = new SR();
      rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
      rec.interimResults = true;
      rec.continuous = true;
      const base = input ? input.trimEnd() + " " : "";
      rec.onresult = (e: any) => {
        let txt = "";
        for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
        setInput((base + txt).replace(/\s+/g, " "));
      };
      rec.onerror = (e: any) => {
        setRecording(false);
        if (e?.error === "not-allowed") setError("Microphone permission was denied.");
        else if (e?.error === "network" || e?.error === "service-not-allowed")
          setError("Voice transcription isn't available in the app - use macOS Dictation (your Dictation key) to speak into the box.");
      };
      rec.onend = () => setRecording(false);
      recRef.current = rec;
      setError(null);
      setRecording(true);
      rec.start();
    } catch {
      setRecording(false);
      setError("Couldn't start voice input.");
    }
  }

  function send(textOverride?: string) {
    const text = (textOverride ?? input).trim();
    if ((!text && !hasAttachments) || busy || !cfg) return;
    if (recording) stopMic();
    if (activeProposers.length === 0) {
      setError("Select at least one agent to ask.");
      return;
    }
    setError(null);

    const useAttach = textOverride === undefined;
    const fileText = useAttach ? pendFiles.map((f) => `\n\n--- ${f.name} ---\n\`\`\`\n${f.text}\n\`\`\``).join("") : "";
    const images: ImagePart[] = useAttach ? pendImages.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 })) : [];
    const userTurn: Turn = {
      role: "user",
      content: text,
      images: images.length ? images : undefined,
      files: useAttach && pendFiles.length ? pendFiles.map((f) => f.name) : undefined,
      fileText: fileText || undefined,
    };

    const history = [...turns, userTurn];
    setTurns(history);
    setInput("");
    setPendImages([]);
    setPendFiles([]);

    const messages = history.map((t) => ({
      role: t.role,
      content: t.content + (t.fileText ?? ""),
      images: t.images,
    }));

    // Hand the generation to the app-level runtime. It streams progress, persists
    // the assistant turn on completion, and fires notifications - all of which
    // keep working if we navigate away. The completion effect above syncs the
    // transcript / clarification / error back into this page when relevant.
    startRun(convId.current, {
      turns: history,
      notifications: cfg.notifications,
      body: {
        messages,
        proposers: activeProposers,
        aggregator: cfg.aggregator,
        conversationId: convId.current,
        rounds: cfg.rounds,
        // Folder context only applies to plan pipelines (folder = plans only).
        workdir: cfg.mode !== "normal" && cfg.folderMode ? cfg.workdir : "",
        mode: cfg.mode,
      },
    });
  }

  // Show the "scroll to bottom" affordance only when the user has scrolled up
  // past ~5% of the viewport (min 100px) from the bottom.
  function onTranscriptScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(dist <= Math.max(100, el.clientHeight * 0.05));
  }
  function scrollToBottom() {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function submitClarify() {
    const ans = clarifyAnswer.trim();
    if (!ans) return;
    setClarify(null);
    setClarifyAnswer("");
    send(ans); // re-runs the same plan mode with the answers in context
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

  // Folders to show in the dropdown: the active one (so it's always visible)
  // followed by the rest of the recents, de-duplicated.
  const displayFolders = cfg
    ? Array.from(new Set([...(cfg.folderMode && cfg.workdir ? [cfg.workdir] : []), ...cfg.recentFolders]))
    : [];

  const bigSwitch = cfg && (
    <div className="inline-flex items-center gap-1 rounded-full bg-subtle p-1.5 shadow-sm">
      <button
        onClick={() => setFolderMode(false)}
        title="Plain chat - agents have no file access"
        className={`flex items-center gap-2.5 rounded-full px-8 py-2.5 text-lg font-semibold transition ${
          !cfg.folderMode ? "bg-bg text-orange-500 shadow ring-1 ring-border" : "text-muted hover:text-fg"
        }`}
      >
        <ChatBubbleIcon /> Chat
      </button>
      <div className="relative" ref={folderRef}>
        <button
          onClick={() => setFolderMenuOpen((o) => !o)}
          title={cfg.workdir ? `Full access: ${cfg.workdir}` : "Choose a folder for full read/edit/run access"}
          className={`flex items-center gap-2.5 rounded-full px-8 py-2.5 text-lg font-semibold transition ${
            cfg.folderMode ? "bg-bg text-orange-500 shadow ring-1 ring-border" : "text-muted hover:text-fg"
          }`}
        >
          <FolderGlyph />
          <span className="max-w-[12rem] truncate">
            {cfg.folderMode && cfg.workdir ? folderName(cfg.workdir) : "Folder"}
          </span>
          <ChevronIcon />
        </button>
        {folderMenuOpen && (
          <div className="absolute left-1/2 top-full z-30 mt-2 w-80 -translate-x-1/2 rounded-2xl border border-border bg-bg p-1.5 text-left shadow-xl">
            {displayFolders.length > 0 && (
              <>
                <div className="max-h-64 overflow-y-auto">
                  {displayFolders.map((f) => {
                    const active = cfg.folderMode && cfg.workdir === f;
                    return (
                      <div key={f} className="group flex items-center">
                        <button
                          onClick={() => selectFolder(f)}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 py-1.5 text-left hover:bg-subtle"
                        >
                          <FolderGlyph />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium">{folderName(f)}</span>
                            <span className="block truncate text-[10px] text-muted">{f}</span>
                          </span>
                          {active && <CheckIcon />}
                        </button>
                        <button
                          onClick={() => removeRecent(f)}
                          title="Remove from list"
                          className="mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted opacity-0 transition hover:bg-subtle hover:text-fg group-hover:opacity-100"
                          aria-label="Remove"
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="my-1 border-t border-border" />
              </>
            )}
            <button
              onClick={pickFolder}
              className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-xs font-medium hover:bg-subtle"
            >
              <PlusIcon /> Choose a folder…
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col px-6">
      {/* In a conversation: a Back button that returns to History (the chat list). */}
      {turns.length > 0 && (
        <div className="pt-4">
          <Link
            href="/history"
            className="flex w-fit items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-sm text-muted transition hover:border-fg hover:text-fg"
          >
            <BackIcon /> History
          </Link>
        </div>
      )}

      {/* Transcript (relative wrapper holds the floating scroll-to-bottom button) */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} onScroll={onTranscriptScroll} className="flex-1 overflow-y-auto pb-10 pt-7">
        {turns.length === 0 ? (
          <div className="mx-auto mt-16 max-w-xl text-center">
            <h1
              className="bg-gradient-to-r from-red-600 to-amber-500 bg-clip-text font-bold tracking-tight text-transparent dark:from-red-500 dark:to-amber-400"
              style={{ fontSize: "4.2rem", lineHeight: 1.05 }}
            >
              Ask once.<br />Multiple agents. <br />One fuses.
            </h1>
            {/* Switcher below the title */}
            {bigSwitch && <div className="mt-10 flex justify-center">{bigSwitch}</div>}
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
          <div className="mt-10 flex gap-4">
            <Avatar role="assistant" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
                <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-muted border-t-transparent" />
                <span className="text-fg">{progress?.label ?? "Thinking…"}</span>
                <span className="text-xs">
                  {fmtElapsed(elapsed)}
                  {progress?.total ? ` · step ${Math.min(progress.done + 1, progress.total)}/${progress.total}` : ""}
                </span>
              </div>
              {progress?.agents && progress.agents.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {progress.agents.map((a, i) => (
                    <span
                      key={i}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                        a.status === "error"
                          ? "border-red-500/50 text-red-500"
                          : a.status === "done"
                            ? "border-border text-muted"
                            : "border-fg text-fg"
                      }`}
                    >
                      {a.status === "running" ? (
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      ) : a.status === "done" ? (
                        <CheckMiniIcon />
                      ) : (
                        <AlertIcon />
                      )}
                      {a.model}
                    </span>
                  ))}
                </div>
              )}
              {progress?.total ? (
                <div className="mt-2 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-subtle">
                  <div
                    className="h-full rounded-full bg-fg transition-all duration-500"
                    style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                  />
                </div>
              ) : null}
            </div>
          </div>
        )}
        {error && <div className="mt-10 rounded-2xl border border-border bg-subtle p-5">{error}</div>}
        </div>
        {!atBottom && turns.length > 0 && (
          <button
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
            className="absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-bg text-muted shadow-lg transition hover:border-fg hover:text-fg"
          >
            <ArrowDownIcon />
          </button>
        )}
      </div>

      {/* Controls - only on the welcome screen; hidden once chatting */}
      {cfg && turns.length === 0 && (
        <div className="flex items-center gap-2 pt-2 text-xs">
          <div className="relative shrink-0" ref={agentsRef}>
            <button
              onClick={() => setAgentsOpen((o) => !o)}
              title="Choose which agents answer"
              className={`${CONTROL} inline-flex items-center gap-1.5 ${agentsOpen ? "!border-fg text-fg" : "text-muted hover:text-fg"}`}
            >
              Agents · {activeProposers.length}/{cfg.proposers.length}
              <ChevronIcon />
            </button>
            {agentsOpen && (
              <div className="absolute bottom-full left-0 z-10 mb-2 w-64 rounded-2xl border border-border bg-bg p-1.5 shadow-lg">
                {cfg.proposers.length === 0 ? (
                  <Link href="/settings" className="block rounded-xl px-3 py-2 text-sm hover:bg-subtle">
                    Add agents in Settings →
                  </Link>
                ) : (
                  cfg.proposers.map((p, i) => {
                    const k = mkey(p);
                    const on = activeKeys.has(k);
                    return (
                      <button
                        key={i}
                        onClick={() => toggleProposer(k)}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-subtle"
                      >
                        <Checkbox on={on} />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          <span className="font-medium">{p.model}</span>
                          <span className="ml-1.5 text-xs text-muted">{p.provider.replace("-cli", "")}</span>
                        </span>
                      </button>
                    );
                  })
                )}
                <Link
                  href="/settings"
                  className="mt-1 block border-t border-border px-3 pb-1 pt-2 text-xs text-muted hover:text-fg"
                >
                  Manage agents →
                </Link>
              </div>
            )}
          </div>
          <div className="flex-1" />

          <div className="flex shrink-0 items-center gap-1.5">
            <div className="relative shrink-0" ref={planRef}>
              <button
                onClick={() => {
                  setPlanHover(null);
                  setPlanOpen((o) => !o);
                }}
                title="How the agents work - Normal answer, or Attack/Relay planning pipelines (saved as .md)."
                className={`${CONTROL} inline-flex items-center gap-1.5 ${cfg.mode !== "normal" ? "!border-fg text-fg" : "text-muted hover:text-fg"}`}
              >
                Mode · {MODE_OPTIONS.find((o) => o.value === cfg.mode)!.label}
                <ChevronIcon />
              </button>
              {planOpen && (
                <div
                  className="absolute bottom-full right-0 z-10 mb-2 w-44 rounded-2xl border border-border bg-bg p-1.5 shadow-lg"
                  onMouseLeave={() => setPlanHover(null)}
                >
                  {/* Folders are for planning, so Normal isn't offered there. */}
                  {MODE_OPTIONS.filter((o) => !cfg.folderMode || o.value !== "normal").map((o) => (
                    <button
                      key={o.value}
                      onMouseEnter={() => setPlanHover(o.value)}
                      onClick={() => {
                        setMode(o.value);
                        setPlanOpen(false);
                      }}
                      title={o.blurb}
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition hover:bg-subtle ${
                        cfg.mode === o.value ? "font-semibold text-fg" : "text-muted"
                      }`}
                    >
                      <span>{o.label}</span>
                      {cfg.mode === o.value && <span className="text-orange-500">●</span>}
                    </button>
                  ))}
                  {/* Big floating preview to the left of the menu (grows upward). */}
                  {(() => {
                    const o = MODE_OPTIONS.find((x) => x.value === planHover);
                    if (!o?.img) return null;
                    return (
                      <div className="pointer-events-none absolute bottom-0 left-full z-20 ml-3 w-72">
                        <img
                          src={o.img}
                          alt={`${o.label} pipeline`}
                          className="w-full rounded-xl border border-border bg-white shadow-2xl"
                        />
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
            <span className="text-muted" title="The model that writes the final fused answer / synthesizes the final plan.">
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
      <div className="pb-3 pt-2">
        <div className="rounded-2xl border border-border bg-subtle p-3 focus-within:border-fg">
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
          <div className="flex items-end gap-1.5">
            <button
              onClick={() => fileRef.current?.click()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-bg hover:text-fg"
              aria-label="Attach files"
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
              className="max-h-52 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] outline-none placeholder:text-muted"
            />
            {/* Context window ring - only once a conversation has started */}
            {turns.length > 0 && (
              <div className="relative shrink-0" ref={ctxRef}>
                <button
                  onClick={() => setCtxOpen((o) => !o)}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-muted transition hover:bg-bg hover:text-fg"
                  aria-label="Context window usage"
                  title="Context window"
                >
                  <ContextRing pct={pctUsed} />
                </button>
                {ctxOpen && (
                  <div className="absolute bottom-full right-0 z-20 mb-2 w-44 rounded-xl border border-border bg-bg p-3 text-center shadow-lg">
                    <div className="text-xs text-muted">Context window</div>
                    <div className="mt-1 text-sm font-medium text-fg">
                      {pctUsed}% used <span className="text-muted">({100 - pctUsed}% left)</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {fmtK(usedTokens)} / {fmtK(CONTEXT_TOKENS)} tokens
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* Voice input - next to send */}
            <button
              onClick={toggleMic}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition ${
                recording ? "animate-pulse bg-red-500 text-white" : "text-muted hover:bg-bg hover:text-fg"
              }`}
              aria-label="Voice input"
              title={recording ? "Stop dictation" : "Speak"}
            >
              <MicIcon />
            </button>
            <button
              onClick={() => send()}
              disabled={busy || (!input.trim() && !hasAttachments)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-fg text-bg transition hover:opacity-80 disabled:opacity-30"
              aria-label="Send"
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Clarification modal - when an agent needs more info before planning */}
      {clarify && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
          onClick={() => {
            setClarify(null);
            setClarifyAnswer("");
          }}
        >
          <div
            className="w-full max-w-lg rounded-3xl border border-border bg-bg p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-lg font-semibold">
              <span className="text-orange-500">⚠︎</span> Fuse needs a bit more info
            </div>
            <p className="mt-1 text-sm text-muted">Answer these and it&apos;ll continue planning.</p>
            <ol className="mt-4 space-y-2">
              {clarify.questions.map((q, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <span className="shrink-0 text-muted">{i + 1}.</span>
                  <span>{q}</span>
                </li>
              ))}
            </ol>
            <textarea
              value={clarifyAnswer}
              onChange={(e) => setClarifyAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitClarify();
              }}
              rows={3}
              autoFocus
              placeholder="Type your answers…"
              className="mt-4 w-full resize-none rounded-2xl border border-border bg-subtle px-4 py-3 text-base outline-none focus:border-fg"
            />
            <div className="mt-4 flex justify-end gap-3 text-sm">
              <button
                onClick={() => {
                  setClarify(null);
                  setClarifyAnswer("");
                }}
                className="rounded-full px-4 py-2 text-muted hover:text-fg"
              >
                Later
              </button>
              <button
                onClick={submitClarify}
                disabled={!clarifyAnswer.trim()}
                className="rounded-full bg-fg px-5 py-2 font-medium text-bg transition hover:opacity-80 disabled:opacity-30"
              >
                Continue planning
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function openPath(p: string) {
  (typeof window !== "undefined" ? (window as any).fuse : null)?.openPath?.(p);
}
function revealPath(p: string) {
  (typeof window !== "undefined" ? (window as any).fuse : null)?.revealPath?.(p);
}

// A light, technical summary of the pipeline for this answer - which stage ran,
// whether it succeeded, the full error text for any that failed, and output
// sizes - so it's quick to copy and paste when something breaks. The agents'
// full replies are intentionally left out (they're available behind "Show agent
// replies" and on the Debug page); this is for diagnosing *where/why* it failed.
function debugDump(turn: Turn): string {
  const n = (x: number) => x.toLocaleString();
  const out: string[] = ["# Fuse - pipeline debug", ""];
  const ps = turn.proposals ?? [];
  if (ps.length) {
    const errs = ps.filter((p) => p.error).length;
    const labels = ps.map((p) => p.model).join(" ");
    const mode = /finalize|harden/.test(labels)
      ? "relay"
      : /synthesize|review of/.test(labels)
        ? "attack"
        : "normal";
    out.push(`Mode: ${mode} · ${ps.length} stage${ps.length === 1 ? "" : "s"} · ${errs} error${errs === 1 ? "" : "s"}`, "");
    out.push("## Stages", "");
    ps.forEach((p, i) => {
      const head = `${i + 1}. ${p.error ? "✗" : "✓"} ${p.provider}/${p.model}`;
      if (p.error) {
        out.push(`${head} - ERROR: ${p.error}`);
      } else {
        const chars = p.content?.trim().length ?? 0;
        const outTok = p.usage?.completion_tokens ?? 0;
        out.push(`${head} - ${chars ? `${n(chars)} chars` : "empty"}${outTok ? `, ${n(outTok)} out tok` : ""}`);
      }
    });
    out.push("");
  }
  const finalLen = turn.content?.trim().length ?? 0;
  out.push("## Final answer", "", finalLen ? `present - ${n(finalLen)} chars` : "(empty)");
  return out.join("\n");
}

// A ready-to-paste prompt for handing the produced plan file(s) to a coding
// agent. The user copies this and drops it straight into Claude Code / Codex /
// etc. to start implementing.
function implementPrompt(files: string[]): string {
  const many = files.length > 1;
  return (
    `Implement the plan in the file${many ? "s" : ""} below. Read ${many ? "each one" : "it"} in full first, ` +
    `follow the steps exactly, then build and run the tests to verify. Ask me before anything destructive or irreversible.\n\n` +
    files.join("\n")
  );
}

// A macOS-attachment-style card for a produced plan file: layered document
// thumbnail on the left, name + type in the middle, and a split action button
// (Open + a chevron menu with Copy path / Show in Folder) on the right.
function PlanFileCard({ path }: { path: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-subtle px-3 py-2.5">
      {/* Layered document thumbnail */}
      <span className="relative h-12 w-11 shrink-0">
        <span className="absolute right-0 top-1 h-9 w-7 rotate-6 rounded-lg border border-border bg-bg/60" />
        <span className="absolute bottom-0 left-0 flex h-9 w-7 items-center justify-center rounded-lg border border-border bg-bg">
          <DocIcon className="h-5 w-5 text-muted" />
        </span>
      </span>

      {/* Name + type */}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{baseName(path)}</div>
        <div className="truncate text-sm text-muted">{fileKind(path)}</div>
      </div>

      {/* Split action button: Open · ⌄ */}
      <div className="relative shrink-0" ref={ref}>
        <div className="flex items-stretch overflow-hidden rounded-lg border border-border">
          <button
            onClick={() => openPath(path)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition hover:bg-fg/5"
          >
            <OpenIcon /> Open
          </button>
          <span className="w-px bg-border" />
          <button
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="More actions"
            className="flex items-center px-1.5 transition hover:bg-fg/5"
          >
            <ChevronIcon />
          </button>
        </div>
        {menuOpen && (
          <div className="absolute right-0 z-20 mt-1.5 w-44 overflow-hidden rounded-xl border border-border bg-bg py-1 shadow-lg">
            <button
              onClick={copyPath}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-subtle"
            >
              {copied ? <CheckMiniIcon /> : <CopyMiniIcon />}
              {copied ? "Copied" : "Copy path"}
            </button>
            <button
              onClick={() => {
                revealPath(path);
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-subtle"
            >
              <FolderGlyph /> Show in Folder
            </button>
          </div>
        )}
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
      <div className="group flex justify-end gap-4">
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
            <>
              <div className="whitespace-pre-wrap rounded-3xl rounded-tr-md bg-fg px-5 py-3.5 text-base text-bg">
                {turn.content}
              </div>
              <div className="mt-1 flex justify-end text-xs opacity-0 transition group-hover:opacity-100">
                <CopyButton text={turn.content} />
              </div>
            </>
          )}
        </div>
        <Avatar role="user" />
      </div>
    );
  }

  const errs = turn.proposals?.filter((p) => p.error) ?? [];
  const hasProposals = !!turn.proposals?.length;
  return (
    <div className="flex gap-4">
      <Avatar role="assistant" />
      <div className="min-w-0 flex-1">
        <Markdown>{turn.content}</Markdown>
        {turn.planFiles && turn.planFiles.length > 0 && (
          <div className="mt-4 space-y-2">
            {/* File cards - macOS-style: layered doc thumbnail, name + type, split action button. */}
            {turn.planFiles.map((f, i) => (
              <PlanFileCard key={i} path={f} />
            ))}

            {/* Hand-off prompt - a single box with an icon-only copy button. */}
            <div className="relative rounded-2xl border border-border bg-subtle p-3">
              <div className="absolute right-2.5 top-2.5">
                <CopyButton text={implementPrompt(turn.planFiles)} />
              </div>
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words pr-8 font-mono text-xs leading-relaxed text-muted">
                {implementPrompt(turn.planFiles)}
              </pre>
            </div>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
          <CopyButton text={turn.content} label="Copy" />
          {hasProposals && (
            <button onClick={onToggle} className="text-muted transition hover:text-fg">
              {open ? "Hide" : "Show"} {turn.proposals!.length} agent replies
            </button>
          )}
          {errs.length > 0 && (
            <button
              onClick={onToggle}
              className="inline-flex items-center gap-1.5 font-medium text-red-500 transition hover:text-red-400"
              title="Some stages failed - click to see what broke"
            >
              <AlertIcon /> {errs.length} issue{errs.length === 1 ? "" : "s"}
            </button>
          )}
          {hasProposals && <CopyButton text={debugDump(turn)} label="Copy debug" />}
          <Link
            href={`/history/${convId}#turn-${index}`}
            className="text-muted transition hover:text-fg"
            title="Open this answer in the history & debug view"
          >
            Debug ↗
          </Link>
        </div>
        {open && turn.proposals && (
          <div className="mt-4 space-y-3">
            {turn.proposals.map((p, j) => (
              <details key={j} className={`rounded-2xl border p-4 ${p.error ? "border-red-500/50" : "border-border"}`} open>
                <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm font-medium">
                  <span className={p.error ? "text-red-500" : "text-muted"}>
                    {p.provider}/{p.model}
                    {p.error ? " - error" : ""}
                  </span>
                  <span className="text-xs">
                    <CopyButton text={p.error ? p.error : p.content} />
                  </span>
                </summary>
                <div className="mt-3">
                  {p.error ? <p className="text-red-500">{p.error}</p> : <Markdown>{p.content}</Markdown>}
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text ?? "");
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {}
      }}
      className="inline-flex items-center gap-1.5 text-muted transition hover:text-fg"
      title={label || "Copy"}
    >
      {done ? <CheckMiniIcon /> : <CopyMiniIcon />}
      {label && <span>{done ? "Copied" : label}</span>}
    </button>
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

function ChatBubbleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
      <circle cx="9" cy="11.5" r="0.6" fill="currentColor" />
      <circle cx="12.5" cy="11.5" r="0.6" fill="currentColor" />
      <circle cx="16" cy="11.5" r="0.6" fill="currentColor" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

// Document glyph (folded corner + lines) for the plan-file cards.
function DocIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M8.5 13h7M8.5 16.5h7" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 3h6v6M21 3l-9 9M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

function CopyMiniIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckMiniIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

// Circular progress ring for context-window usage.
function ContextRing({ pct }: { pct: number }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  const used = (Math.min(100, Math.max(0, pct)) / 100) * c;
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="-rotate-90">
      <circle cx="10" cy="10" r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
      <circle
        cx="10"
        cy="10"
        r={r}
        fill="none"
        stroke={pct >= 85 ? "#f97316" : "var(--fg)"}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${used} ${c}`}
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-orange-500">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function Checkbox({ on }: { on: boolean }) {
  return (
    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? "border-fg bg-fg text-bg" : "border-border"}`}>
      {on && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </span>
  );
}

