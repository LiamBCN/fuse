import { NextResponse } from "next/server";
import { readUsage } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const records = await readUsage();

  // Per-day totals (local date string) and per-model totals for charts.
  const byDay: Record<string, { tokens: number; cost: number }> = {};
  const byModel: Record<string, { tokens: number; cost: number; calls: number }> = {};
  let totalTokens = 0;
  let totalCost = 0;
  let totalCalls = 0;

  for (const rec of records) {
    const day = new Date(rec.ts).toISOString().slice(0, 10);
    for (const item of rec.items) {
      byDay[day] ??= { tokens: 0, cost: 0 };
      byDay[day].tokens += item.total_tokens;
      byDay[day].cost += item.cost;

      const key = `${item.provider}/${item.model}`;
      byModel[key] ??= { tokens: 0, cost: 0, calls: 0 };
      byModel[key].tokens += item.total_tokens;
      byModel[key].cost += item.cost;
      byModel[key].calls += 1;

      totalTokens += item.total_tokens;
      totalCost += item.cost;
      totalCalls += 1;
    }
  }

  const daily = Object.entries(byDay)
    .map(([day, v]) => ({ day, tokens: v.tokens, cost: Number(v.cost.toFixed(4)) }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const models = Object.entries(byModel)
    .map(([model, v]) => ({ model, tokens: v.tokens, cost: Number(v.cost.toFixed(4)), calls: v.calls }))
    .sort((a, b) => b.tokens - a.tokens);

  return NextResponse.json({
    totals: { tokens: totalTokens, cost: Number(totalCost.toFixed(4)), calls: totalCalls, conversations: records.length },
    daily,
    models,
  });
}
