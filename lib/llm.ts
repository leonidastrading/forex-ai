import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config, llmCost } from "./config";

export const DecisionSchema = z.object({
  action: z.enum(["buy", "sell", "close", "hold"]),
  units: z.number().int().describe("EUR units, multiple of 1000. 0 for hold/close."),
  reason: z.string().describe("One short line, in character."),
});
export type BotDecision = z.infer<typeof DecisionSchema>;

export interface LlmResult {
  decision: BotDecision | null; // null = unusable response (refusal, truncated, invalid)
  error?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  raw: unknown;
}

let client: Anthropic | undefined;

export async function askBot(systemPrompt: string, userMessage: string, model?: string | null): Promise<LlmResult> {
  const started = Date.now();
  const modelId = model || config.llmModel;
  if (config.llmProvider === "mock") return mockDecision(modelId, started);

  client ??= new Anthropic({
    maxRetries: 1,
    timeout: 45_000,
    // Org-level API keys (not scoped to a workspace) must name the workspace on every request.
    defaultHeaders: config.anthropicWorkspaceId ? { "anthropic-workspace-id": config.anthropicWorkspaceId } : undefined,
  });
  try {
    const res = await client.messages.parse({
      model: modelId,
      max_tokens: config.llmMaxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      output_config: { effort: config.llmEffort, format: zodOutputFormat(DecisionSchema) },
    });
    const inputTokens = res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    const outputTokens = res.usage.output_tokens;
    const base = {
      model: modelId,
      inputTokens,
      outputTokens,
      costUsd: llmCost(inputTokens, outputTokens),
      latencyMs: Date.now() - started,
      raw: { id: res.id, stop_reason: res.stop_reason, content: res.content.filter((b) => b.type === "text") },
    };
    if (res.stop_reason !== "end_turn" || !res.parsed_output) {
      return { ...base, decision: null, error: `unusable response (stop_reason=${res.stop_reason})` };
    }
    return { ...base, decision: res.parsed_output };
  } catch (err) {
    return {
      decision: null,
      error: err instanceof Error ? err.message.slice(0, 500) : String(err),
      model: modelId,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: Date.now() - started,
      raw: null,
    };
  }
}

// LLM_PROVIDER=mock: random decisions, zero cost. For wiring tests only.
function mockDecision(model: string, started: number): LlmResult {
  const r = Math.random();
  const action: BotDecision["action"] = r < 0.25 ? "buy" : r < 0.5 ? "sell" : r < 0.6 ? "close" : "hold";
  const units = action === "buy" || action === "sell" ? 1000 * (1 + Math.floor(Math.random() * 50)) : 0;
  return {
    decision: { action, units, reason: `mock ${action}` },
    model: `mock:${model}`,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs: Date.now() - started,
    raw: null,
  };
}
