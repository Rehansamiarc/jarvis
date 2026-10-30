import "server-only";
import { env } from "@/lib/env";
import { GEMINI_NATIVE_BASE, GEMINI_OPENAI_BASE } from "./providers";
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
 * Output is capped with the classic `max_tokens` name, which the shim honours (verified
 * against the live endpoint). It is not optional: `gemini-3.8-flash` spent 82 seconds on
 * reasoning tokens and then returned `finish_reason: "length"` with empty content when
 * uncapped, so an uncapped request can look like a hang and still answer nothing.
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
    // Default to Google's shim, never to the OpenAI transport's own default: sending a
    // Gemini key to api.openai.com would spend a request on a guaranteed 401.
    baseUrl: options.baseUrl ?? GEMINI_OPENAI_BASE,
    capabilities: options.capabilities,
    // The shim accepts the classic `max_tokens` name (verified: it caps the response),
    // and sending it matters — an uncapped reasoning model can spend a minute of latency
    // on reasoning tokens before returning nothing at all.
    tokenParam: "max_tokens",
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
        // `embedContent` (single text) takes a singular `content` object; the plural
        // `contents` array only exists on `generateContent`. Sending the plural form here
        // is answered with 400 `Unknown name "contents"`, which is why every document
        // ingestion and memory embedding failed. The model is addressed by the URL path
        // only, so it is not repeated in the body.
        body: JSON.stringify({
          model: `models/${model}`,
          content: { parts: [{ text }] },
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
