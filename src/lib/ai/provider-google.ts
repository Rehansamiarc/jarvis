import "server-only";
import { env } from "@/lib/env";
import { GEMINI_NATIVE_BASE } from "./providers";
import { createOpenAIProvider, ProviderError, ProviderUnavailableError } from "./provider-openai";
import type { ModelProvider, ProviderCapabilities } from "./types";

/**
 * Google Gemini provider.
 *
 * Chat rides Google's documented OpenAI-compatible shim, so tool calling and JSON
 * output behave exactly like every other provider here. Embeddings do not: Google
 * ships no OpenAI-compatible /embeddings endpoint, so they use the native
 * `embedContent` call — which is also the only way to ask for a specific dimension,
 * and 1536 is one of the sizes Google explicitly supports (default is 3072).
 *
 * Token caps are not sent: the shim does not document `max_completion_tokens`, and a
 * rejected parameter would break every call where the agent caps its own output.
 */

const EMBED_CONCURRENCY = 3;
const EMBED_TIMEOUT_MS = 60_000;

interface GoogleProviderOptions {
  apiKey: string;
  baseUrl?: string;
  capabilities?: Partial<ProviderCapabilities>;
}

export function createGoogleProvider(options: GoogleProviderOptions): ModelProvider {
  const chat = createOpenAIProvider({
    id: "google",
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    capabilities: options.capabilities,
    tokenParam: "none",
  });

  async function embedOne(text: string, model: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
      const response = await fetch(`${GEMINI_NATIVE_BASE}/models/${model}:embedContent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": options.apiKey,
        },
        body: JSON.stringify({
          model: `models/${model}`,
          contents: [{ parts: [{ text }] }],
          outputDimensionality: env().JARVIS_EMBEDDING_DIM ?? 1536,
        }),
        signal: controller.signal,
        cache: "no-store",
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new ProviderError(
          `Embedding model "${model}" returned HTTP ${response.status}: ${body.slice(0, 300)}`,
          response.status,
          response.status === 429 || response.status >= 500,
          model
        );
      }

      const json = (await response.json()) as { embedding?: { values?: number[] } };
      const values = json.embedding?.values;
      if (!Array.isArray(values) || values.length === 0) {
        throw new ProviderError(`Embedding model "${model}" returned no vector`, 502, true, model);
      }
      return values;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new ProviderUnavailableError(
        aborted
          ? `Embedding request for "${model}" timed out after ${EMBED_TIMEOUT_MS}ms`
          : `Embedding request failed: ${(error as Error).message}`,
        model,
        aborted ? 504 : 502
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: "google",
    capabilities: chat.capabilities,

    chat: chat.chat,

    async embed(texts: string[], model: string): Promise<number[][]> {
      if (!texts.length) return [];
      const results: number[][] = new Array(texts.length);
      let cursor = 0;

      // embedContent is one text per call, so run a small pool instead of a burst that
      // would burn the free tier's requests-per-minute in a single chunking pass.
      async function worker(): Promise<void> {
        while (cursor < texts.length) {
          const index = cursor++;
          results[index] = await embedOne(texts[index], model);
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(EMBED_CONCURRENCY, texts.length) }, () => worker())
      );
      return results;
    },
  };
}
