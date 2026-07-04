"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ModeBadge from "@/components/ModeBadge";
import { formatPercent, totalSessionDelta } from "@/lib/limit-format";
import {
  inferMode,
  listConversations,
  deleteConversation,
  saveActiveId,
  clearActiveId,
  type StoredConversation,
} from "@/lib/conversations";
import { getRun, isRunning, runningConvIds, runsVersion, subscribeRuns } from "@/lib/chat-runtime";

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const conversationLimitPct = (c: StoredConversation) =>
  c.turns.reduce((sum, turn) => sum + totalSessionDelta(turn.limits), 0);

export default function HistoryPage() {
  const [convs, setConvs] = useState<StoredConversation[] | null>(null);
  const router = useRouter();

  // Live view of in-flight generations so we can badge conversations that are
  // still generating (started here or from the chat page) without leaving.
  useSyncExternalStore(subscribeRuns, runsVersion, runsVersion);
  const runningKey = runningConvIds().sort().join(",");

  useEffect(() => {
    listConversations().then(setConvs);
  }, []);

  // Refresh the list whenever a generation starts or finishes, so a conversation
  // that just completed shows its new reply/timestamp.
  useEffect(() => {
    listConversations().then(setConvs);
  }, [runningKey]);

  async function remove(id: string) {
    await deleteConversation(id);
    setConvs(await listConversations());
  }

  // Reopen a past conversation as the live chat.
  function resume(id: string) {
    saveActiveId(id);
    router.push("/");
  }

  // Start a fresh chat: drop the active pointer so the chat page opens empty.
  function newChat() {
    clearActiveId();
    router.push("/");
  }

  if (!convs) return <div className="p-12 text-lg text-muted">Loading…</div>;

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto px-6 py-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-semibold tracking-tight">History</h1>
          <p className="mt-2 text-muted">
            Every conversation, with each agent&apos;s individual answer for debugging.
          </p>
        </div>
        <button
          onClick={newChat}
          className="shrink-0 rounded-full bg-fg px-5 py-2.5 text-base font-medium text-bg transition hover:opacity-90"
        >
          New chat
        </button>
      </div>

      {convs.length === 0 ? (
        <div className="mt-16 rounded-3xl border border-border p-16 text-center text-lg text-muted">
          No conversations yet. Ask something on the{" "}
          <Link href="/" className="underline">Chat</Link> tab.
        </div>
      ) : (
        <div className="mt-10 space-y-3">
          {convs.map((c) => {
            const userTurns = c.turns.filter((t) => t.role === "user").length;
            const lastAssistant = [...c.turns].reverse().find((t) => t.role === "assistant");
            const running = getRun(c.id);
            const preview = lastAssistant?.content.replace(/\s+/g, " ").slice(0, 140);
            const limitPct = conversationLimitPct(c);
            return (
              <div
                key={c.id}
                className="group flex items-start gap-4 rounded-2xl border border-border p-5 transition hover:border-fg"
              >
                {/* Clicking a conversation always reopens it live to continue,
                    not the read-only view - that's the Debug link below. */}
                <button onClick={() => resume(c.id)} className="min-w-0 flex-1 text-left" title="Resume this conversation">
                  <div className="flex items-center gap-3">
                    <span className="truncate text-lg font-medium">{c.title}</span>
                    {lastAssistant && <ModeBadge mode={inferMode(lastAssistant)} />}
                    {limitPct > 0 && (
                      <span className="inline-flex shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted">
                        ≈{formatPercent(limitPct)} 5h
                      </span>
                    )}
                    {isRunning(c.id) && (
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-fg px-2 py-0.5 text-xs font-medium text-fg">
                        <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                        Generating…
                        <ModeBadge mode={running?.mode} className="border-current text-current" />
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-sm text-muted">
                    {fmtDate(c.updatedAt)} · {userTurns} message{userTurns === 1 ? "" : "s"}
                  </div>
                  {preview && <p className="mt-2 line-clamp-2 text-sm text-muted">{preview}</p>}
                </button>
                <div className="flex shrink-0 flex-col items-end gap-2 text-sm">
                  <Link href={`/history/${c.id}`} className="text-muted underline hover:text-fg" title="Per-agent debug view">
                    Debug
                  </Link>
                  <button onClick={() => remove(c.id)} className="text-muted underline hover:text-fg">
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
