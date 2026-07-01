import { NextRequest, NextResponse } from "next/server";
import { runMoa, type ModelRef } from "@/lib/moa";
import { runPlan } from "@/lib/plan";
import { appendUsage } from "@/lib/db";
import type { ChatMessage } from "@/lib/providers";
import type { Mode, Usage } from "@/lib/types";
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

interface ChatBody {
  messages: ChatMessage[];
  proposers: ModelRef[];
  aggregator: ModelRef;
  conversationId: string;
  rounds?: number;
  workdir?: string;
  mode?: Mode;
}

export async function POST(req: NextRequest) {
  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { messages, proposers, aggregator, conversationId, rounds, workdir, mode } = body;
  if (!messages?.length) return NextResponse.json({ error: "No messages" }, { status: 400 });
  if (!proposers?.length) return NextResponse.json({ error: "Select at least one agent" }, { status: 400 });
  if (!aggregator?.model) return NextResponse.json({ error: "Select an aggregator model" }, { status: 400 });

  // Stream progress as Server-Sent Events, then a final result/error event.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const onProgress = (done: number, total: number, label: string, agents?: unknown) =>
        send({ type: "progress", done, total, label, agents });
      try {
        if (mode === "attack" || mode === "relay") {
          const result = await runPlan(messages, proposers, aggregator, mode, workdir || undefined, onProgress);
          if (result.usageItems.length) {
            await appendUsage({ ts: Date.now(), conversationId: conversationId ?? "default", items: result.usageItems });
          }
          const usage = sumUsage(result.usageItems);
          if (result.needsClarification) {
            send({ type: "result", final: result.final, proposals: result.proposals, usage, needsClarification: true, questions: result.questions });
          } else {
            send({ type: "result", final: result.final, proposals: result.proposals, usage, planPath: result.planPath, files: result.files });
          }
        } else {
          const result = await runMoa(messages, proposers, aggregator, rounds ?? 1, workdir, onProgress);
          if (result.usageItems.length) {
            await appendUsage({ ts: Date.now(), conversationId: conversationId ?? "default", items: result.usageItems });
          }
          send({ type: "result", final: result.final, proposals: result.proposals, usage: sumUsage(result.usageItems) });
        }
      } catch (e: any) {
        send({ type: "error", error: e?.message ?? String(e) });
      } finally {
        controller.close();
      }
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
