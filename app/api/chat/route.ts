import { NextRequest, NextResponse } from "next/server";
import { runMoa, type ModelRef } from "@/lib/moa";
import { runPlan } from "@/lib/plan";
import { appendUsage } from "@/lib/db";
import { AgentFailedError, RunStoppedError, classifyCliError, registerRun } from "@/lib/run-control";
import { diffLimitSnapshots, fetchAllLimits } from "@/lib/limits";
import type { ChatMessage } from "@/lib/providers";
import type { ErrorInfo, LimitSnapshot, Mode, StageModelMap, Usage, UsageLimitDeltas } from "@/lib/types";
import type { UsageItem } from "@/lib/db";

export const runtime = "nodejs";

// Roll every agent's usage (proposers + aggregator) into one total for the
// answer, so the client can show "how many tokens this reply cost".
const sumUsage = (items: UsageItem[]): Usage =>
  items.reduce(
    (a, it) => ({
      prompt_tokens: a.prompt_tokens + (it.prompt_tokens || 0),
      completion_tokens: a.completion_tokens + (it.completion_tokens || 0),
      total_tokens: a.total_tokens + (it.total_tokens || 0),
    }),
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  );

const latestCodexThreadId = (items: UsageItem[]): string | undefined =>
  [...items].reverse().find((item) => item.provider === "codex-cli" && item.sessionId)?.sessionId;

async function captureLimitDeltas(
  before: LimitSnapshot | null,
  items: UsageItem[],
): Promise<{ deltas?: UsageLimitDeltas; snapshot?: LimitSnapshot }> {
  if (!items.length) return {};
  const after = await fetchAllLimits({ force: true, codexThreadId: latestCodexThreadId(items) }).catch(() => null);
  return {
    deltas: diffLimitSnapshots(before, after),
    snapshot: after ?? undefined,
  };
}

function resetFromLimits(info: ErrorInfo, limits: LimitSnapshot): number | undefined {
  const provider = info.provider;
  if (provider) return limits[provider]?.session?.resetsAt ?? undefined;
  return limits.claude.session?.resetsAt ?? limits.codex.session?.resetsAt ?? undefined;
}

interface ChatBody {
  messages: ChatMessage[];
  proposers: ModelRef[];
  aggregator: ModelRef;
  conversationId: string;
  rounds?: number;
  workdir?: string;
  mode?: Mode;
  stageModels?: StageModelMap;
}

export async function POST(req: NextRequest) {
  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { messages, proposers, aggregator, conversationId, rounds, workdir, mode, stageModels } = body;
  const convKey = conversationId ?? "default";
  const selectedMode: Mode = mode === "fast" || mode === "relay" || mode === "recon" ? mode : "fast";
  if (!messages?.length) return NextResponse.json({ error: "No messages" }, { status: 400 });
  if (!proposers?.length) return NextResponse.json({ error: "Select at least one agent" }, { status: 400 });
  if (!aggregator?.model) return NextResponse.json({ error: "Select an aggregator model" }, { status: 400 });

  const ac = new AbortController();
  const unregister = registerRun(convKey, ac);
  const onReqAbort = () => ac.abort();
  req.signal.addEventListener("abort", onReqAbort);
  if (req.signal.aborted) ac.abort();

  // Stream progress as Server-Sent Events, then a final result/error event.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const onProgress = (done: number, total: number, label: string, agents?: unknown) =>
        send({ type: "progress", done, total, label, agents });
      const onStage = (stages: unknown) => send({ type: "stage", stages });
      const limitBefore = await fetchAllLimits().catch(() => null);
      try {
        if (workdir) {
          const result = await runPlan(messages, proposers, aggregator, selectedMode, workdir, onProgress, onStage, stageModels, ac.signal);
          const { deltas } = await captureLimitDeltas(limitBefore, result.usageItems);
          if (result.usageItems.length) {
            await appendUsage({ ts: Date.now(), conversationId: convKey, items: result.usageItems, limits: deltas });
          }
          const usage = sumUsage(result.usageItems);
          if (result.needsClarification) {
            send({ type: "result", mode: selectedMode, final: result.final, proposals: result.proposals, usage, limits: deltas, needsClarification: true, questions: result.questions });
          } else {
            send({ type: "result", mode: selectedMode, final: result.final, proposals: result.proposals, usage, limits: deltas, planPath: result.planPath, files: result.files });
          }
        } else {
          const result = await runMoa(messages, proposers, aggregator, rounds ?? 1, workdir, onProgress, ac.signal);
          const { deltas } = await captureLimitDeltas(limitBefore, result.usageItems);
          if (result.usageItems.length) {
            await appendUsage({ ts: Date.now(), conversationId: convKey, items: result.usageItems, limits: deltas });
          }
          send({ type: "result", mode: selectedMode, final: result.final, proposals: result.proposals, usage: sumUsage(result.usageItems), limits: deltas });
        }
      } catch (e: any) {
        ac.abort();
        const items = e instanceof AgentFailedError || e instanceof RunStoppedError ? e.usageItems : [];
        const { deltas, snapshot } = await captureLimitDeltas(limitBefore, items);
        if (items.length) await appendUsage({ ts: Date.now(), conversationId: convKey, items, limits: deltas }).catch(() => {});
        if (!(e instanceof RunStoppedError)) {
          let info: ErrorInfo =
            e instanceof AgentFailedError
              ? e.info
              : classifyCliError(e?.message ?? String(e));
          if (info.kind === "rate-limit") {
            const limits = snapshot ?? (await fetchAllLimits({ force: true }).catch(() => undefined));
            if (limits) {
              info = { ...info, limits, resetsAt: info.resetsAt ?? resetFromLimits(info, limits) };
            }
          }
          try {
            send({ type: "error", error: e?.message ?? String(e), info });
          } catch {
            /* client may already be gone */
          }
        }
      } finally {
        req.signal.removeEventListener("abort", onReqAbort);
        unregister();
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      ac.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
