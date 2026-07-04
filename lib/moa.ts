// Mixture-of-Agents orchestration.
// 1. Fan the conversation out to every selected "proposer" model in parallel.
// 2. Hand all proposals to one "aggregator" model that synthesizes a final answer.
import { callModel, type ChatMessage } from "./providers";
import { estimateCost } from "./models";
import { AgentFailedError, RunStoppedError, classifyCliError } from "./run-control";
import type { ModelRef, Proposal } from "./types";
import type { UsageItem } from "./db";

export type { ModelRef, Proposal } from "./types";

export interface MoaResult {
  final: string;
  proposals: Proposal[];
  usageItems: UsageItem[];
}

// Live status of one agent running in parallel.
export type AgentStatus = { model: string; status: "running" | "done" | "error" };

// Reports pipeline progress: how many stages are done out of total, a label,
// and (during the parallel agent phase) each agent's live status.
export type ProgressFn = (done: number, total: number, label: string, agents?: AgentStatus[]) => void;

const AGGREGATOR_SYSTEM = `You are the aggregator in a Mixture-of-Agents system. You have been given a user request along with candidate responses from several different AI models. Your job is to synthesize the single best possible answer.

- Combine the strongest, most correct points from each candidate.
- Resolve contradictions by reasoning about which is most likely correct.
- Do not mention that you are aggregating or refer to "the models" or "candidates" - just produce the final answer directly.
- Be accurate, complete, and well-organized.`;

const REFINE_SYSTEM = `You are one assistant in a Mixture-of-Agents system. You will see the user request followed by candidate responses from several assistants (including possibly your own). Use them as reference material to produce a single improved response that is more complete, accurate, and well-reasoned than any individual candidate. Do not mention the other responses or that you are refining - just give the best answer to the original request.`;

const peerBlock = (good: Proposal[]) =>
  good.map((p, i) => `### Candidate ${i + 1} (${p.provider}/${p.model})\n${p.content}`).join("\n\n");

// Run one proposer layer in parallel. `peers` (if given) are the previous
// round's answers, fed to every proposer so it can refine. A failing model is
// recorded for the debug view and aborts its siblings.
async function runLayer(
  proposers: ModelRef[],
  baseMessages: ChatMessage[],
  usageItems: UsageItem[],
  peers: Proposal[] | null,
  workdir?: string,
  signal?: AbortSignal,
  onOne?: (i: number, p: ModelRef, error: boolean) => void,
  onError?: () => void,
): Promise<Proposal[]> {
  const messages: ChatMessage[] = peers
    ? [
        ...baseMessages,
        {
          role: "user",
          content:
            `Candidate responses from several assistants to the request above:\n\n${peerBlock(peers)}\n\n` +
            `Using these as reference, write a single improved response to the original request.`,
        },
      ]
    : baseMessages;

  return Promise.all(
    proposers.map(async (p, i): Promise<Proposal> => {
      try {
        const r = await callModel({ provider: p.provider, model: p.model, messages, workdir, signal });
        usageItems.push({
          provider: p.provider,
          model: p.model,
          role: "proposer",
          ...r.usage,
          cost: estimateCost(p.model, r.usage.prompt_tokens, r.usage.completion_tokens),
          sessionId: r.sessionId,
        });
        onOne?.(i, p, false);
        return { provider: p.provider, model: p.model, content: r.content, usage: r.usage };
      } catch (e: any) {
        onOne?.(i, p, true);
        onError?.();
        return {
          provider: p.provider,
          model: p.model,
          content: "",
          error: e?.message ?? String(e),
          errorInfo: classifyCliError(e?.message ?? String(e), {
            provider: p.provider === "claude-cli" ? "claude" : p.provider === "codex-cli" ? "codex" : undefined,
            providerModel: `${p.provider}/${p.model}`,
          }),
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      }
    }),
  );
}

export async function runMoa(
  messages: ChatMessage[],
  proposers: ModelRef[],
  aggregator: ModelRef,
  rounds = 1,
  workdir?: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<MoaResult> {
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    return await runMoaInner(messages, proposers, aggregator, rounds, workdir, onProgress, signal, ac);
  } finally {
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

async function runMoaInner(
  messages: ChatMessage[],
  proposers: ModelRef[],
  aggregator: ModelRef,
  rounds: number,
  workdir: string | undefined,
  onProgress: ProgressFn | undefined,
  outerSignal: AbortSignal | undefined,
  ac: AbortController,
): Promise<MoaResult> {
  const usageItems: UsageItem[] = [];
  const layers = Math.max(1, Math.min(rounds, 4)); // clamp to a sane range
  const isRunStoppedMessage = (msg: string | undefined) => !!msg && /^Run stopped\.?$/i.test(msg.trim());
  const assertNotStopped = () => {
    if (outerSignal?.aborted) throw new RunStoppedError(usageItems);
  };
  const failFirstProposalError = (proposals: Proposal[]) => {
    const failed =
      proposals.find((p) => p.error && !isRunStoppedMessage(p.error)) ??
      proposals.find((p) => p.error);
    if (failed?.error) throw new AgentFailedError("Proposer", `${failed.provider}/${failed.model}`, failed.error, usageItems);
  };

  const total = proposers.length + 1; // every agent + the final fuse
  let done = 0;
  const agents: AgentStatus[] = proposers.map((p) => ({ model: p.model, status: "running" }));
  const snap = () => agents.map((a) => ({ ...a }));
  onProgress?.(0, total, `${proposers.length} agents working in parallel…`, snap());
  const bump = (i: number, _p: ModelRef, error: boolean) => {
    done++;
    if (agents[i]) agents[i].status = error ? "error" : "done";
    onProgress?.(done, total, `${done}/${proposers.length} agents answered`, snap());
  };

  // Layer 1: independent answers. Each extra layer feeds the previous answers
  // back to every proposer to refine (the layered Mixture-of-Agents pattern).
  let proposals = await runLayer(proposers, messages, usageItems, null, workdir, ac.signal, bump, () => ac.abort());
  assertNotStopped();
  failFirstProposalError(proposals);
  for (let layer = 2; layer <= layers; layer++) {
    const prev = proposals.filter((p) => !p.error && p.content.trim());
    if (prev.length === 0) break; // nothing to refine from
    proposals = await runLayer(proposers, messages, usageItems, prev, workdir, ac.signal, undefined, () => ac.abort());
    assertNotStopped();
    failFirstProposalError(proposals);
  }
  onProgress?.(proposers.length, total, "Fusing answers…", snap());

  const good = proposals.filter((p) => !p.error && p.content.trim());
  const userTurn = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  const synthesisPrompt =
    `User request:\n${userTurn}\n\n` +
    `Candidate responses:\n\n${peerBlock(good)}\n\n` +
    `Synthesize the best final answer.`;

  const aggMessages: ChatMessage[] = [
    { role: "system", content: AGGREGATOR_SYSTEM },
    { role: "user", content: synthesisPrompt },
  ];

  let agg;
  try {
    agg = await callModel({
      provider: aggregator.provider,
      model: aggregator.model,
      messages: aggMessages,
      workdir,
      signal: ac.signal,
    });
  } catch (e: any) {
    assertNotStopped();
    throw new AgentFailedError("Aggregator", `${aggregator.provider}/${aggregator.model}`, e?.message ?? String(e), usageItems);
  }
  assertNotStopped();

  usageItems.push({
    provider: aggregator.provider,
    model: aggregator.model,
    role: "aggregator",
    ...agg.usage,
    cost: estimateCost(aggregator.model, agg.usage.prompt_tokens, agg.usage.completion_tokens),
    sessionId: agg.sessionId,
  });

  onProgress?.(total, total, "Done");
  return { final: agg.content, proposals, usageItems };
}
