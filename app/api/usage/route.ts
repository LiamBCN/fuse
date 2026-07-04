import { NextResponse } from "next/server";
import { readUsage } from "@/lib/db";

export const runtime = "nodejs";
// Always re-read usage.json on each request - otherwise Next caches the first
// response and the stats appear frozen as new usage is recorded.
export const dynamic = "force-dynamic";

export async function GET() {
  const records = await readUsage();

  // Per-day token totals (for the line chart) and per-model in/out token totals.
  // Fuse runs through local CLIs (subscription) - we track tokens, not cost.
  const byDay: Record<string, { tokens: number }> = {};
  const byModel: Record<string, { input: number; output: number; tokens: number; calls: number }> = {};
  const byConversation: Record<
    string,
    {
      input: number;
      output: number;
      tokens: number;
      calls: number;
      claudeSession: number;
      claudeWeekly: number;
      codexSession: number;
      codexWeekly: number;
      approx: boolean;
      lastTs: number;
    }
  > = {};
  const conversations = new Set<string>();
  let totalTokens = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCalls = 0;

  for (const rec of records) {
    const conversationId = rec.conversationId || String(rec.ts);
    conversations.add(conversationId);
    byConversation[conversationId] ??= {
      input: 0,
      output: 0,
      tokens: 0,
      calls: 0,
      claudeSession: 0,
      claudeWeekly: 0,
      codexSession: 0,
      codexWeekly: 0,
      approx: false,
      lastTs: 0,
    };
    const conv = byConversation[conversationId];
    conv.claudeSession += rec.limits?.claude?.sessionDeltaPct ?? 0;
    conv.claudeWeekly += rec.limits?.claude?.weeklyDeltaPct ?? 0;
    conv.codexSession += rec.limits?.codex?.sessionDeltaPct ?? 0;
    conv.codexWeekly += rec.limits?.codex?.weeklyDeltaPct ?? 0;
    conv.approx ||= !!rec.limits?.approx;
    conv.lastTs = Math.max(conv.lastTs, rec.ts);
    const day = new Date(rec.ts).toISOString().slice(0, 10);
    for (const item of rec.items) {
      byDay[day] ??= { tokens: 0 };
      byDay[day].tokens += item.total_tokens;

      const key = `${item.provider}/${item.model}`;
      byModel[key] ??= { input: 0, output: 0, tokens: 0, calls: 0 };
      byModel[key].input += item.prompt_tokens;
      byModel[key].output += item.completion_tokens;
      byModel[key].tokens += item.total_tokens;
      byModel[key].calls += 1;

      totalTokens += item.total_tokens;
      totalInput += item.prompt_tokens;
      totalOutput += item.completion_tokens;
      totalCalls += 1;

      conv.input += item.prompt_tokens;
      conv.output += item.completion_tokens;
      conv.tokens += item.total_tokens;
      conv.calls += 1;
    }
  }

  const daily = Object.entries(byDay)
    .map(([day, v]) => ({ day, tokens: v.tokens }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const models = Object.entries(byModel)
    .map(([model, v]) => ({ model, input: v.input, output: v.output, tokens: v.tokens, calls: v.calls }))
    .sort((a, b) => b.tokens - a.tokens);

  const conversationRows = Object.entries(byConversation)
    .map(([conversationId, v]) => ({
      conversationId,
      input: v.input,
      output: v.output,
      tokens: v.tokens,
      calls: v.calls,
      claudeSession: v.claudeSession,
      claudeWeekly: v.claudeWeekly,
      codexSession: v.codexSession,
      codexWeekly: v.codexWeekly,
      approx: v.approx,
      lastTs: v.lastTs,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return NextResponse.json({
    totals: { tokens: totalTokens, input: totalInput, output: totalOutput, calls: totalCalls, conversations: conversations.size },
    daily,
    models,
    conversations: conversationRows,
  });
}
