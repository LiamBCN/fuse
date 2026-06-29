// Mixture-of-Agents orchestration.
// 1. Fan the conversation out to every selected "proposer" model in parallel.
// 2. Hand all proposals to one "aggregator" model that synthesizes a final answer.
import { callModel, type ChatMessage } from "./providers";
import { estimateCost } from "./models";
import type { ModelRef, Proposal } from "./types";
import type { UsageItem } from "./db";

export type { ModelRef, Proposal } from "./types";

export interface MoaResult {
  final: string;
  proposals: Proposal[];
  usageItems: UsageItem[];
}

const AGGREGATOR_SYSTEM = `You are the aggregator in a Mixture-of-Agents system. You have been given a user request along with candidate responses from several different AI models. Your job is to synthesize the single best possible answer.

- Combine the strongest, most correct points from each candidate.
- Resolve contradictions by reasoning about which is most likely correct.
- Do not mention that you are aggregating or refer to "the models" or "candidates" — just produce the final answer directly.
- Be accurate, complete, and well-organized.`;

const REFINE_SYSTEM = `You are one assistant in a Mixture-of-Agents system. You will see the user request followed by candidate responses from several assistants (including possibly your own). Use them as reference material to produce a single improved response that is more complete, accurate, and well-reasoned than any individual candidate. Do not mention the other responses or that you are refining — just give the best answer to the original request.`;

const peerBlock = (good: Proposal[]) =>
  good.map((p, i) => `### Candidate ${i + 1} (${p.provider}/${p.model})\n${p.content}`).join("\n\n");

// Run one proposer layer in parallel. `peers` (if given) are the previous
// round's answers, fed to every proposer so it can refine. A failing model
// degrades gracefully to an error proposal.
async function runLayer(
  proposers: ModelRef[],
  baseMessages: ChatMessage[],
  usageItems: UsageItem[],
  peers: Proposal[] | null,
  workdir?: string,
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
    proposers.map(async (p): Promise<Proposal> => {
      try {
        const r = await callModel({ provider: p.provider, model: p.model, messages, workdir });
        usageItems.push({
          provider: p.provider,
          model: p.model,
          role: "proposer",
          ...r.usage,
          cost: estimateCost(p.model, r.usage.prompt_tokens, r.usage.completion_tokens),
        });
        return { provider: p.provider, model: p.model, content: r.content, usage: r.usage };
      } catch (e: any) {
        return {
          provider: p.provider,
          model: p.model,
          content: "",
          error: e?.message ?? String(e),
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
): Promise<MoaResult> {
  const usageItems: UsageItem[] = [];
  const layers = Math.max(1, Math.min(rounds, 4)); // clamp to a sane range

  // Layer 1: independent answers. Each extra layer feeds the previous answers
  // back to every proposer to refine (the layered Mixture-of-Agents pattern).
  let proposals = await runLayer(proposers, messages, usageItems, null, workdir);
  for (let layer = 2; layer <= layers; layer++) {
    const prev = proposals.filter((p) => !p.error && p.content.trim());
    if (prev.length === 0) break; // nothing to refine from
    proposals = await runLayer(proposers, messages, usageItems, prev, workdir);
  }

  const good = proposals.filter((p) => !p.error && p.content.trim());
  const userTurn = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  // Final stage: aggregator. If no proposer succeeded, surface the errors.
  if (good.length === 0) {
    const errs = proposals.map((p) => `- ${p.provider}/${p.model}: ${p.error ?? "empty"}`).join("\n");
    return { final: `All proposer models failed:\n\n${errs}`, proposals, usageItems };
  }

  const synthesisPrompt =
    `User request:\n${userTurn}\n\n` +
    `Candidate responses:\n\n${peerBlock(good)}\n\n` +
    `Synthesize the best final answer.`;

  const aggMessages: ChatMessage[] = [
    { role: "system", content: AGGREGATOR_SYSTEM },
    { role: "user", content: synthesisPrompt },
  ];

  const agg = await callModel({
    provider: aggregator.provider,
    model: aggregator.model,
    messages: aggMessages,
    workdir,
  });

  usageItems.push({
    provider: aggregator.provider,
    model: aggregator.model,
    role: "aggregator",
    ...agg.usage,
    cost: estimateCost(aggregator.model, agg.usage.prompt_tokens, agg.usage.completion_tokens),
  });

  return { final: agg.content, proposals, usageItems };
}
