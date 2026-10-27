import "server-only";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelProvider,
  ProviderCapabilities,
  ToolCall,
  ToolSpec,
} from "./types";
import { inferCapabilities } from "./types";

/**
 * OpenAI-compatible provider implemented on `fetch`.
 *
 * Using the wire protocol rather than a vendor SDK keeps this interchangeable with any
 * endpoint that speaks `/chat/completions` + `/embeddings`: OpenAI, OpenRouter, Groq,
 * Together, Ollama, LM Studio, and the Anthropic/OpenAI compatibility layer.
 */

const DEFAULT_TIMEOUT_MS = 45_000;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly model: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(message: string, model: string, status = 503) {
    super(message, status, true, model);
    this.name = "ProviderUnavailableError";
  }
}

interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  capabilities?: Partial<ProviderCapabilities>;
  /** Identifier reported on the provider and used for usage logging. */
  id?: string;
  /**
   * How to cap output length. Newer OpenAI models reject `max_tokens` in favour of
   * `max_completion_tokens`; some vendors (Gemini's shim, Ollama) document neither,
   * and an unrecognised parameter fails the whole request — so it can be disabled.
   */
  tokenParam?: "max_completion_tokens" | "none";
}

export function createOpenAIProvider(options: OpenAIProviderOptions): ModelProvider {
  const baseUrl = (options.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const providerId = options.id ?? "openai";
  const tokenParam = options.tokenParam ?? "max_completion_tokens";
  const capabilities: ProviderCapabilities = {
    tools: true,
    json: true,
    vision: false,
    ...options.capabilities,
  };

  async function post<T>(path: string, body: unknown, model: string, request: ChatRequest): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onOuterAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onOuterAbort);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new ProviderUnavailableError(
        aborted
          ? `Model "${model}" timed out after ${request.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
          : `Could not reach model endpoint for "${model}": ${(error as Error).message}`,
        model,
        aborted ? 504 : 502
      );
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onOuterAbort);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const retryable = response.status === 429 || response.status >= 500;
      // 4xx other than 429 means the request itself is wrong for this model (bad param,
      // unsupported tool, context overflow) — retrying identical input will not help.
      throw new ProviderError(
        `Model "${model}" returned HTTP ${response.status}: ${text.slice(0, 500)}`,
        response.status,
        retryable,
        model
      );
    }

    return (await response.json()) as T;
  }

  return {
    id: providerId,
    capabilities,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const started = Date.now();
      const model = request.model;

      if (request.tools?.length && !capabilities.tools) {
        throw new ProviderError(
          `Model "${model}" does not support tool calling`,
          400,
          false,
          model
        );
      }

      const payload: Record<string, unknown> = {
        model,
        messages: request.messages satisfies ChatMessage[],
      };
      if (request.tools?.length) {
        payload.tools = request.tools satisfies ToolSpec[];
        payload.tool_choice = "auto";
      }
      if (request.temperature !== undefined) payload.temperature = request.temperature;
      if (request.maxOutputTokens !== undefined && tokenParam !== "none") {
        // Newer reasoning models reject `max_tokens`; they want `max_completion_tokens`.
        payload.max_completion_tokens = request.maxOutputTokens;
      }
      if (request.json && capabilities.json) {
        payload.response_format = { type: "json_object" };
      }

      const raw = await post<{
        choices?: Array<{
          message: ChatMessage;
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      }>("/chat/completions", payload, model, request);

      const choice = raw.choices?.[0];
      if (!choice) {
        throw new ProviderError(`Model "${model}" returned no choices`, 502, true, model);
      }

      return {
        message: {
          role: "assistant",
          content: choice.message.content ?? null,
          tool_calls: choice.message.tool_calls?.map(
            (t): ToolCall => ({
              id: t.id,
              type: "function",
              function: { name: t.function.name, arguments: t.function.arguments ?? "{}" },
            })
          ),
        },
        finishReason: choice.finish_reason ?? "stop",
        usage: {
          inputTokens: raw.usage?.prompt_tokens ?? 0,
          outputTokens: raw.usage?.completion_tokens ?? 0,
        },
        model: raw.model ?? model,
        latencyMs: Date.now() - started,
      };
    },

    async embed(texts: string[], model: string): Promise<number[][]> {
      if (!texts.length) return [];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const response = await fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({ model, input: texts }),
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new ProviderError(
            `Embedding model "${model}" returned HTTP ${response.status}: ${text.slice(0, 300)}`,
            response.status,
            response.status === 429 || response.status >= 500,
            model
          );
        }
        const json = (await response.json()) as { data?: Array<{ embedding: number[] }> };
        return (json.data ?? []).map((d) => d.embedding);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderUnavailableError(
          `Embedding request failed: ${(error as Error).message}`,
          model,
          502
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/**
 * Capability hints for a model name. Kept here so callers that only need "can this
 * model call tools / see images" do not have to import the whole provider module.
 */
export function providerSupports(model: string): ProviderCapabilities {
  return inferCapabilities(model);
}
