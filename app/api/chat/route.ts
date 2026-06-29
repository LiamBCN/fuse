import { NextRequest, NextResponse } from "next/server";
import { runMoa, type ModelRef } from "@/lib/moa";
import { appendUsage } from "@/lib/db";
import type { ChatMessage } from "@/lib/providers";

export const runtime = "nodejs";

interface ChatBody {
  messages: ChatMessage[];
  proposers: ModelRef[];
  aggregator: ModelRef;
  conversationId: string;
  rounds?: number;
  workdir?: string;
}

export async function POST(req: NextRequest) {
  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { messages, proposers, aggregator, conversationId, rounds, workdir } = body;
  if (!messages?.length) return NextResponse.json({ error: "No messages" }, { status: 400 });
  if (!proposers?.length) return NextResponse.json({ error: "Select at least one agent" }, { status: 400 });
  if (!aggregator?.model) return NextResponse.json({ error: "Select an aggregator model" }, { status: 400 });

  try {
    const result = await runMoa(messages, proposers, aggregator, rounds ?? 1, workdir);

    if (result.usageItems.length) {
      await appendUsage({
        ts: Date.now(),
        conversationId: conversationId ?? "default",
        items: result.usageItems,
      });
    }

    return NextResponse.json({
      final: result.final,
      proposals: result.proposals,
      usage: result.usageItems,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
