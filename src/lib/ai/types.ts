/**
 * Provider-agnostic model types.
 *
 * Nothing downstream of this file knows it is talking to OpenAI: swapping the model
 * family (or adding a second vendor) means implementing `ModelProvider`, not touching
 * the agent, tools, or integrations.
 */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: MessageRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema. Produced by `z.toJSONSchema()` so it always matches the server validator. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  tools?: ToolSpec[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Ask for a JSON object answer. Only honoured when `capabilities.json` is true. */
  json?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  message: ChatMessage;
  finishReason: string;
  usage: TokenUsage;
  model: string;
  latencyMs: number;
}

export interface ProviderCapabilities {
  /** Supports function/tool calling. */
  tools: boolean;
  /** Supports structured JSON output. */
  json: boolean;
  /** Accepts image inputs. */
  vision: boolean;
}

export interface ModelProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  chat(request: ChatRequest): Promise<ChatResponse>;
  embed(texts: string[], model: string): Promise<number[][]>;
}

/** Where a request should be routed. */
export type ModelRole =
  | "primary"
  | "coding"
  | "research"
  | "summary"
  | "vision"
  | "speech"
  | "embedding";

export interface ResolvedModel {
  provider: string;
  model: string;
  baseUrl?: string;
  capabilities: ProviderCapabilities;
  role: ModelRole;
}

/**
 * Capability hints. Unknown models are assumed to support tools (the common case for
 * current chat models) but NOT vision or structured output, which fail loudly when the
 * model does not implement them. Explicit entries always win.
 */
const CAPABILITY_TABLE: Array<{
  match: RegExp;
  capabilities: Partial<ProviderCapabilities>;
}> = [
  { match: /^(gpt-5|o[34]|chatgpt-)/i, capabilities: { tools: true, json: true, vision: true } },
  { match: /^(gpt-4\.1|gpt-4o|gpt-4-turbo)/i, capabilities: { tools: true, json: true, vision: true } },
  { match: /^(gpt-3\.5|gpt-4(?:-|$|[^.o]))/i, capabilities: { tools: true, json: true, vision: false } },
  { match: /^(claude-)/i, capabilities: { tools: true, json: false, vision: true } },
  { match: /^(gemini-)/i, capabilities: { tools: true, json: true, vision: true } },
  { match: /(llama|mistral|qwen|deepseek|codestral)/i, capabilities: { tools: true, json: false, vision: false } },
  { match: /^(text-embedding-|embedding-)/i, capabilities: { tools: false, json: false, vision: false } },
];

export function inferCapabilities(model: string): ProviderCapabilities {
  for (const entry of CAPABILITY_TABLE) {
    if (entry.match.test(model)) {
      return { tools: true, json: false, vision: false, ...entry.capabilities };
    }
  }
  return { tools: true, json: false, vision: false };
}
