"use client";
import { useEffect, useState } from "react";
import { LimitMeter, useLimits } from "@/components/LimitMeter";
import { formatPercent } from "@/lib/limit-format";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from "recharts";

interface UsageData {
  totals: { tokens: number; input: number; output: number; calls: number; conversations: number };
  daily: { day: string; tokens: number }[];
  models: { model: string; input: number; output: number; tokens: number; calls: number }[];
  conversations: {
    conversationId: string;
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
  }[];
}

// Monochrome bars: same fill (CSS var) with descending opacity for separation.
const barOpacity = (i: number, n: number) => 1 - (i / Math.max(n, 1)) * 0.6;

const tooltipStyle = {
  background: "var(--subtle)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  color: "var(--fg)",
  fontSize: 14,
};

export default function StatsPage() {
  const [data, setData] = useState<UsageData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { limits } = useLimits(false);

  useEffect(() => {
    fetch("/api/usage").then((r) => r.json()).then(setData).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div className="p-12 text-lg">{err}</div>;
  if (!data) return <div className="p-12 text-lg text-muted">Loading…</div>;

  const empty = data.totals.calls === 0;

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto px-6 py-12">
      <h1 className="text-4xl font-semibold tracking-tight">Token usage</h1>
      <p className="mt-2 text-muted">
        Fuse runs on your local CLI subscriptions - these are token counts, not billed costs.
      </p>

      {empty ? (
        <div className="mt-16 rounded-3xl border border-border p-16 text-center text-lg text-muted">
          No usage recorded yet. Send a message on the Chat tab.
        </div>
      ) : (
        <>
          <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Total tokens" value={data.totals.tokens.toLocaleString()} />
            <Stat label="Output tokens" value={data.totals.output.toLocaleString()} />
            <Stat label="Model calls" value={data.totals.calls.toLocaleString()} />
            <Stat label="Conversations" value={data.totals.conversations.toLocaleString()} />
          </div>

          <Card title="Current limits">
            <LimitMeter limits={limits} />
          </Card>

          <Card title="Tokens per day">
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={data.daily} margin={{ top: 8, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" fontSize={13} tickLine={false} axisLine={false} />
                <YAxis fontSize={13} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Line type="monotone" dataKey="tokens" strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Tokens by model">
            <ResponsiveContainer width="100%" height={Math.max(180, data.models.length * 52)}>
              <BarChart data={data.models} layout="vertical" margin={{ left: 30, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" fontSize={13} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="model" fontSize={13} width={170} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--subtle)" }} />
                <Bar dataKey="tokens" radius={[0, 6, 6, 0]}>
                  {data.models.map((_, i) => (
                    <Cell key={i} fillOpacity={barOpacity(i, data.models.length)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Breakdown">
            <table className="w-full text-left text-base">
              <thead className="text-sm uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-3">Model</th>
                  <th className="py-3 text-right">Calls</th>
                  <th className="py-3 text-right">Input</th>
                  <th className="py-3 text-right">Output</th>
                  <th className="py-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.models.map((m) => (
                  <tr key={m.model} className="border-t border-border">
                    <td className="py-3">{m.model}</td>
                    <td className="py-3 text-right text-muted">{m.calls}</td>
                    <td className="py-3 text-right text-muted">{m.input.toLocaleString()}</td>
                    <td className="py-3 text-right text-muted">{m.output.toLocaleString()}</td>
                    <td className="py-3 text-right">{m.tokens.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Conversations">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-base">
                <thead className="text-sm uppercase tracking-wide text-muted">
                  <tr>
                    <th className="py-3">Conversation</th>
                    <th className="py-3 text-right">Calls</th>
                    <th className="py-3 text-right">Input</th>
                    <th className="py-3 text-right">Output</th>
                    <th className="py-3 text-right">Total</th>
                    <th className="py-3 text-right">Claude 5h</th>
                    <th className="py-3 text-right">Codex 5h</th>
                    <th className="py-3 text-right">Weekly</th>
                  </tr>
                </thead>
                <tbody>
                  {data.conversations.map((c) => (
                    <tr key={c.conversationId} className="border-t border-border">
                      <td className="max-w-[16rem] truncate py-3" title={c.conversationId}>
                        {c.conversationId}
                        {c.approx && <span className="ml-1 text-muted">≈</span>}
                      </td>
                      <td className="py-3 text-right text-muted">{c.calls}</td>
                      <td className="py-3 text-right text-muted">{c.input.toLocaleString()}</td>
                      <td className="py-3 text-right text-muted">{c.output.toLocaleString()}</td>
                      <td className="py-3 text-right">{c.tokens.toLocaleString()}</td>
                      <td className="py-3 text-right text-muted">≈{formatPercent(c.claudeSession)}</td>
                      <td className="py-3 text-right text-muted">≈{formatPercent(c.codexSession)}</td>
                      <td className="py-3 text-right text-muted">
                        ≈{formatPercent(c.claudeWeekly + c.codexWeekly)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border p-5">
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-8 rounded-3xl border border-border p-6">
      <h2 className="mb-5 text-xl font-semibold">{title}</h2>
      {children}
    </div>
  );
}
