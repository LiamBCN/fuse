"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  listConversations,
  deleteConversation,
  saveActiveId,
  type StoredConversation,
} from "@/lib/conversations";

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export default function HistoryPage() {
  const [convs, setConvs] = useState<StoredConversation[] | null>(null);
  const router = useRouter();

  useEffect(() => {
    listConversations().then(setConvs);
  }, []);

  async function remove(id: string) {
    await deleteConversation(id);
    setConvs(await listConversations());
  }

  // Reopen a past conversation as the live chat.
  function resume(id: string) {
    saveActiveId(id);
    router.push("/");
  }

  if (!convs) return <div className="p-12 text-lg text-muted">Loading…</div>;

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto px-6 py-12">
      <h1 className="text-4xl font-semibold tracking-tight">History</h1>
      <p className="mt-2 text-muted">
        Every conversation, with each agent&apos;s individual answer for debugging.
      </p>

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
            const preview = lastAssistant?.content.replace(/\s+/g, " ").slice(0, 140);
            return (
              <div
                key={c.id}
                className="group flex items-start gap-4 rounded-2xl border border-border p-5 transition hover:border-fg"
              >
                <Link href={`/history/${c.id}`} className="min-w-0 flex-1">
                  <div className="flex items-center gap-3">
                    <span className="truncate text-lg font-medium">{c.title}</span>
                  </div>
                  <div className="mt-1 text-sm text-muted">
                    {fmtDate(c.updatedAt)} · {userTurns} message{userTurns === 1 ? "" : "s"}
                  </div>
                  {preview && <p className="mt-2 line-clamp-2 text-sm text-muted">{preview}</p>}
                </Link>
                <div className="flex shrink-0 flex-col items-end gap-2 text-sm">
                  <button onClick={() => resume(c.id)} className="text-muted underline hover:text-fg">
                    Resume
                  </button>
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
