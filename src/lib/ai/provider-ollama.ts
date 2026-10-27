import "server-only";
import { createOpenAIProvider, ProviderError, ProviderUnavailableError } from "./provider-openai";
import type {
  ChatRequest,
  ChatResponse,
  ModelProvider,
  ProviderCapabilities,
  ToolCall,
  ToolSpec,
} from "./types";

/**
 * Local Ollama provider.
 *
 * Everything runs on this machine: no key, no quota, no data leaving the device.
 * Chat uses Ollama's OpenAI-compatible surface; embeddings use Ollama's native
 * `/api/embed` endpoint, which is not exposed under /v1. Structured-output mode is
 * disabled because the transport sends `response_format`, which Ollama does not
 * implement — the prompt itself must ask for JSON.
 *
 * Tool-call compatibility: Ollama reports a model as tool-capable, but not every
 * downloaded model actually emits native `tool_calls` through the OpenAI shim — some
 * print the call as JSON in the assistant text instead. Verified against
 * `qwen2.5-coder:7b` on this machine. `parseLegacyToolCall` recognises that shape and
 * converts it into a real tool call, but only when the model was actually offered that
 * tool, so an ordinary JSON answer is passed through untouched.
 *
 * Enabled only when OLLAMA_BASE_URL is set (see providers.ts) so machines without
 * Ollama are never probed.
 */

const EMBED_TIMEOUT_MS = 60_000;

interface OllamaProviderOptions {
  baseUrl: string;
  capabilities?: Partial<ProviderCapabilities>;
}

export function createOllamaProvider(options: OllamaProviderOptions): ModelProvider {
  const chat = createOpenAIProvider({
    id: "ollama",
    apiKey: "ollama",
    baseUrl: options.baseUrl,
    capabilities: { json: false, ...options.capabilities },
    tokenParam: "none",
  });

  const origin = options.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");

  async function embed(texts: string[], model: string): Promise<number[][]> {
    if (!texts.length) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
      const response = await fetch(`${origin}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: texts }),
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

      const json = (await response.json()) as { embeddings?: number[][] };
      if (!Array.isArray(json.embeddings) || json.embeddings.length !== texts.length) {
        throw new ProviderError(`Ollama returned ${json.embeddings?.length ?? 0} vectors for ${texts.length} inputs`, 502, true, model);
      }
      return json.embeddings;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new ProviderUnavailableError(
        aborted
          ? `Embedding request for "${model}" timed out after ${EMBED_TIMEOUT_MS}ms`
          : `Ollama embeddings failed: ${(error as Error).message}. Is \`ollama serve\` running and \`ollama pull ${model}\` done?`,
        model,
        aborted ? 504 : 502
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: "ollama",
    capabilities: chat.capabilities,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const response = await chat.chat(request);
      const tools = request.tools ?? [];
      if (response.message.tool_calls?.length || !tools.length) return response;

      const shimmed = parseLegacyToolCall(response.message.content, tools);
      if (!shimmed) return response;

      return {
        ...response,
        finishReason: "tool_calls",
        message: { ...response.message, content: null, tool_calls: [shimmed] },
      };
    },

    embed,
  };
}

/**
 * Recognise a tool call the model printed as JSON instead of emitting natively.
 *
 * Only a single JSON object that names a tool the request actually offered is
 * accepted — anything else is left as assistant text so a genuine JSON answer is never
 * mistaken for a tool call.
 */
export function parseLegacyToolCall(
  content: string | null | undefined,
  tools: ToolSpec[]
): ToolCall | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const rawName = parsed.name ?? parsed.tool ?? parsed.function;
  const rawArgs = parsed.arguments ?? parsed.args ?? parsed.parameters;
  if (typeof rawName !== "string" || !rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return null;
  }

  // The model must have been offered this exact tool; a lookalike name is not enough.
  if (!tools.some((tool) => tool.name.toLowerCase() === rawName.toLowerCase())) return null;

  return {
    id: `ollama-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type: "function",
    function: {
      name: rawName,
      arguments: JSON.stringify(rawArgs),
    },
  };
}
