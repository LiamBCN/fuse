"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import Markdown from "@/components/Markdown";
import ModeBadge from "@/components/ModeBadge";
import { formatLimitDeltas } from "@/lib/limit-format";
import {
  inferMode,
  loadConversation,
  saveActiveId,
  type StoredConversation,
} from "@/lib/conversations";
import type { ErrorInfo, ImagePart, Proposal } from "@/lib/types";

const dataUrl = (img: ImagePart) => `data:${img.mediaType};base64,${img.dataBase64}`;
const fmtNum = (n: number) => n.toLocaleString();
const errorSummary = (info: ErrorInfo | undefined, fallback: string | undefined) => {
  const provider = info?.provider === "claude" ? "Claude" : info?.provider === "codex" ? "Codex" : "Agent";
  if (info?.kind === "rate-limit") return `${provider} usage limit reached`;
  if (info?.kind === "auth") return `${provider} CLI not authenticated`;
  if (info?.kind === "timeout") return "Agent timed out";
  return fallback?.split("\n")[0]?.slice(0, 120) || "Stage failed";
};

export default function HistoryDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [conv, setConv] = useState<StoredConversation | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    loadConversation(params.id).then((c) => {
      if (c) setConv(c);
      else setMissing(true);
    });
  }, [params.id]);

  // Jump to the specific answer when arriving from a "Debug ↗" link (#turn-N).
  useEffect(() => {
    if (!conv) return;
    const hash = window.location.hash.replace("#", "");
    if (hash) document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [conv]);

  function resume() {
    if (!conv) return;
    saveActiveId(conv.id);
    router.push("/");
  }

  if (missing) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <Link href="/history" className="text-sm text-muted underline hover:text-fg">← History</Link>
        <div className="mt-8 rounded-3xl border border-border p-16 text-center text-lg text-muted">
          This conversation no longer exists.
        </div>
      </div>
    );
  }
  if (!conv) return <div className="p-12 text-lg text-muted">Loading…</div>;

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto px-6 py-12">
      <div className="flex items-center justify-between gap-4">
        <Link href="/history" className="text-sm text-muted underline hover:text-fg">← History</Link>
        <button onClick={resume} className="text-sm text-muted underline hover:text-fg">
          Resume in chat
        </button>
      </div>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">{conv.title}</h1>

      <div className="mt-10 space-y-8">
        {conv.turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} id={`turn-${i}`} className="scroll-mt-6">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">You</div>
              {(t.images?.length || t.files?.length) && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {t.images?.map((img, k) => (
                    <img key={k} src={dataUrl(img)} alt="" className="h-20 w-20 rounded-xl border border-border object-cover" />
                  ))}
                  {t.files?.map((name, k) => (
                    <span key={k} className="rounded-xl border border-border px-3 py-2 text-sm">📄 {name}</span>
                  ))}
                </div>
              )}
              {t.content && (
                <div className="mt-2 whitespace-pre-wrap rounded-2xl bg-subtle px-5 py-3.5 text-base">
                  {t.content}
                </div>
              )}
            </div>
          ) : (
            <div key={i} id={`turn-${i}`} className="scroll-mt-6">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Fused answer</div>
                <ModeBadge mode={inferMode(t)} />
                {t.usage && t.limits && (
                  <span className="text-xs text-muted">
                    {formatLimitDeltas(t.limits, t.usage.total_tokens)}
                  </span>
                )}
              </div>
              <div className="mt-2">
                <Markdown>{t.content}</Markdown>
              </div>

              {t.proposals && t.proposals.length > 0 && (
                <div className="mt-5">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                    {t.proposals.length} agent{t.proposals.length === 1 ? "" : "s"} answered
                  </div>
                  <div className="mt-3 space-y-3">
                    {t.proposals.map((p, j) => (
                      <AgentCard key={j} p={p} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function AgentCard({ p }: { p: Proposal }) {
  const failed = !!p.error;
  return (
    <details className="rounded-2xl border border-border p-4" open>
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">
          {p.provider}/{p.model}
        </span>
        {failed ? (
          <span className="rounded-full bg-subtle px-2 py-0.5 text-xs text-muted">
            {errorSummary(p.errorInfo, p.error)}
          </span>
        ) : (
          <span className="text-xs text-muted">
            {fmtNum(p.usage.prompt_tokens)} in · {fmtNum(p.usage.completion_tokens)} out ·{" "}
            {fmtNum(p.usage.total_tokens)} tokens
          </span>
        )}
      </summary>
      <div className="mt-3 border-t border-border pt-3">
        {failed ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-red-500">{errorSummary(p.errorInfo, p.error)}</p>
            <details className="text-sm text-muted">
              <summary className="cursor-pointer">Raw CLI output</summary>
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{p.error}</pre>
            </details>
          </div>
        ) : (
          <Markdown>{p.content}</Markdown>
        )}
      </div>
    </details>
  );
}
