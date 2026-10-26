import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TokenUsage } from "./types";

/**
 * Approximate list prices per million tokens (USD). Unknown models cost 0 and are
 * flagged as estimates — we would rather under-report than invent a number.
 */
const PRICE_TABLE: Array<{ match: RegExp; input: number; output: number }> = [
  { match: /^(gpt-5)$/i, input: 1.25, output: 10.0 },
  { match: /^(gpt-5-mini)/i, input: 0.25, output: 2.0 },
  { match: /^(gpt-5-nano)/i, input: 0.05, output: 0.4 },
  { match: /^(gpt-4\.1)/i, input: 2.0, output: 8.0 },
  { match: /^(gpt-4o-mini)/i, input: 0.15, output: 0.6 },
  { match: /^(gpt-4o)/i, input: 2.5, output: 10.0 },
  { match: /^text-embedding-3-small/i, input: 0.02, output: 0 },
  { match: /^text-embedding-3-large/i, input: 0.13, output: 0 },
];

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const entry = PRICE_TABLE.find((p) => p.match.test(model));
  if (!entry) return 0;
  return (
    (usage.inputTokens / 1_000_000) * entry.input + (usage.outputTokens / 1_000_000) * entry.output
  );
}

export interface UsageRecord {
  provider: string;
  model: string;
  operation: "chat" | "embed" | "stt" | "tts" | "tool";
  usage?: TokenUsage;
  latencyMs?: number;
  conversationId?: string | null;
}

/**
 * Append a usage row. Failure is swallowed deliberately: telemetry must never be able to
 * fail a user-facing request, but the failure is still surfaced through logging.
 */
export async function logUsage(
  client: SupabaseClient,
  userId: string,
  record: UsageRecord
): Promise<void> {
  const usage = record.usage ?? { inputTokens: 0, outputTokens: 0 };
  const { error } = await client.from("usage_logs").insert({
    user_id: userId,
    provider: record.provider,
    model: record.model,
    operation: record.operation,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_usd: Number(estimateCostUsd(record.model, usage).toFixed(6)),
    latency_ms: record.latencyMs ?? null,
    conversation_id: record.conversationId ?? null,
  });
  if (error) console.warn("[jarvis] usage_logs insert failed:", error.message);
}
