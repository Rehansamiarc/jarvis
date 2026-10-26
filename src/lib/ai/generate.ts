import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withModelFallback } from "./model-manager";
import { logUsage, type UsageRecord } from "./usage";
import type { ModelRole } from "./types";

/**
 * Bounded single-shot generation used by tools that need a focused sub-generation
 * (YouTube metadata drafts, conversation summaries) without entering the agent loop.
 *
 * Always passes a hard message budget so a tool cannot quietly become an unbounded
 * conversation, and always records usage.
 */
export async function generateText(
  db: SupabaseClient,
  userId: string,
  input: {
    system: string;
    prompt: string;
    role?: ModelRole;
    json?: boolean;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    conversationId?: string | null;
    usage?: Omit<UsageRecord, "provider" | "model" | "operation" | "usage">;
  }
): Promise<string> {
  const role = input.role ?? "primary";

  const response = await withModelFallback(
    db,
    role,
    userId,
    async (provider, model) =>
      provider.chat({
        model: model.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
        json: input.json,
        temperature: input.temperature ?? 0.7,
        maxOutputTokens: input.maxTokens ?? 1200,
        timeoutMs: input.timeoutMs ?? 45_000,
      }),
    { needJson: input.json }
  );

  await logUsage(db, userId, {
    provider: "openai",
    model: response.model,
    operation: "chat",
    usage: response.usage,
    latencyMs: response.latencyMs,
    conversationId: input.conversationId ?? null,
  });

  const text = response.message.content?.trim();
  if (!text) throw new Error(`Model "${response.model}" returned an empty response.`);
  return text;
}

/** Cheap summarisation for conversation history compression. */
export async function summarize(
  db: SupabaseClient,
  userId: string,
  transcript: string,
  existingSummary?: string | null
): Promise<string> {
  return generateText(db, userId, {
    role: "summary",
    system:
      "You compress conversation transcripts into durable notes. Return 3-6 short bullet " +
      "points capturing decisions, commitments, preferences and open questions. Do not " +
      "comment on the format. Facts only.",
    prompt: existingSummary
      ? `Existing summary:\n${existingSummary}\n\nNew transcript:\n${transcript}`
      : `Transcript:\n${transcript}`,
    maxTokens: 500,
    temperature: 0.2,
    timeoutMs: 30_000,
  });
}
