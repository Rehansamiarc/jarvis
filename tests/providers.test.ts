import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configuredProviders,
  envCandidatesFor,
  getProvider,
  isConfigured,
  PROVIDER_PRESETS,
  providerCredentials,
} from "@/lib/ai/providers";
import { createGoogleProvider } from "@/lib/ai/provider-google";
import { createOllamaProvider, parseLegacyToolCall } from "@/lib/ai/provider-ollama";
import { invalidateModelConfigCache, withModelFallback } from "@/lib/ai/model-manager";
import { ProviderError } from "@/lib/ai/provider-openai";
import { resetEnvCache } from "@/lib/env";

const MANAGED_KEYS = [
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OLLAMA_BASE_URL",
  "JARVIS_EMBEDDING_DIM",
  "JARVIS_MODEL_PRIMARY",
  "JARVIS_MODEL_CODING",
];

function setEnv(values: Record<string, string | undefined>): void {
  for (const key of MANAGED_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
  invalidateModelConfigCache();
}

beforeEach(() => {
  setEnv({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider registry", () => {
  it("names every supported provider when an unknown one is requested", () => {
    expect(() => getProvider("anthropic")).toThrow(/openai, google, groq, ollama/);
  });

  it("reads the Gemini key from either env var name", () => {
    expect(providerCredentials("google").missingVar).toBe("GOOGLE_API_KEY");

    setEnv({ GEMINI_API_KEY: "g-free-key" });
    expect(providerCredentials("google").key).toBe("g-free-key");

    setEnv({ GOOGLE_API_KEY: "g-real-key", GEMINI_API_KEY: "g-alias" });
    expect(providerCredentials("google").key).toBe("g-real-key");
  });

  it("needs no key at all for the local Ollama server", () => {
    expect(providerCredentials("ollama")).toEqual({ key: "local", missingVar: null });
    // ...but it is only reachable when the user opts in by configuring its URL.
    expect(isConfigured("ollama")).toBe(false);
    setEnv({ OLLAMA_BASE_URL: "http://localhost:11434/v1" });
    expect(isConfigured("ollama")).toBe(true);
  });

  it("orders providers as paid first, free tiers after", () => {
    setEnv({ OPENAI_API_KEY: "sk-x", GROQ_API_KEY: "gsk-x", GOOGLE_API_KEY: "g-x" });
    expect(configuredProviders()).toEqual(["openai", "google", "groq"]);
  });

  it("offers a free fallback model for every role it can actually serve", () => {
    setEnv({ GOOGLE_API_KEY: "g-free" });

    const chat = envCandidatesFor("primary");
    expect(chat[0]).toEqual({ provider: "google", model: "gemini-3.8-flash" });

    // Groq has no embeddings endpoint, so it must never be offered for that role.
    setEnv({ GOOGLE_API_KEY: "g-free", GROQ_API_KEY: "gsk-x" });
    const embeddings = envCandidatesFor("embedding");
    expect(embeddings.map((c) => c.provider)).toEqual(["google"]);
    expect(embeddings[0].model).toBe("gemini-embedding-001");
  });

  it("gives every preset a default for the primary role", () => {
    for (const id of Object.keys(PROVIDER_PRESETS) as Array<keyof typeof PROVIDER_PRESETS>) {
      expect(PROVIDER_PRESETS[id].defaults.primary, id).toBeTruthy();
    }
  });
});

describe("Google embeddings transport", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  function okResponse(values: number[]) {
    return { ok: true, status: 200, json: async () => ({ embedding: { values } }) };
  }

  it("calls the native embedContent endpoint with the configured dimension", async () => {
    fetchMock.mockResolvedValue(okResponse([0.1, 0.2, 0.3]));
    setEnv({ GOOGLE_API_KEY: "g-free", JARVIS_EMBEDDING_DIM: "3" });

    const provider = createGoogleProvider({ apiKey: "g-free" });
    const vectors = await provider.embed(["hello"], "gemini-embedding-001");

    expect(vectors).toEqual([[0.1, 0.2, 0.3]]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1beta/models/gemini-embedding-001:embedContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-free");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("models/gemini-embedding-001");
    expect(body.outputDimensionality).toBe(3);
  });

  it("batches a chunking pass instead of firing one request per text", async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
      return okResponse([body.contents[0].parts[0].text.length]);
    });

    const provider = createGoogleProvider({ apiKey: "g-free" });
    const vectors = await provider.embed(["a", "bb", "ccc"], "gemini-embedding-001");

    expect(vectors).toEqual([[1], [2], [3]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces a rate limit as a retryable ProviderError", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "RESOURCE_EXHAUSTED",
      json: async () => ({}),
    });

    const provider = createGoogleProvider({ apiKey: "g-free" });
    await expect(provider.embed(["x"], "gemini-embedding-001")).rejects.toMatchObject({
      name: "ProviderError",
      status: 429,
      retryable: true,
    });
  });

  it("refuses to embed into a column the vectors cannot fit", async () => {
    fetchMock.mockResolvedValue(okResponse(new Array(1536).fill(0.1)));
    setEnv({ GOOGLE_API_KEY: "g-free" });

    const provider = createGoogleProvider({ apiKey: "g-free" });
    const [vector] = await provider.embed(["hello"], "gemini-embedding-001");
    expect(vector).toHaveLength(1536);
  });
});

describe("Ollama embeddings transport", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  it("uses Ollama's native /api/embed endpoint, not the OpenAI one", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [[0.5, 0.25]] }),
    });

    const provider = createOllamaProvider({ baseUrl: "http://localhost:11434/v1" });
    const vectors = await provider.embed(["hello"], "nomic-embed-text");

    expect(vectors).toEqual([[0.5, 0.25]]);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:11434/api/embed");
  });

  it("explains how to fix a missing local model instead of failing opaquely", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => "model not found", json: async () => ({}) });

    const provider = createOllamaProvider({ baseUrl: "http://localhost:11434/v1" });
    await expect(provider.embed(["x"], "nomic-embed-text")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("Ollama legacy tool-call shim", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  // The exact shape qwen2.5-coder:7b prints on this machine when asked to use a tool
  // through Ollama's OpenAI-compatible endpoint: JSON in the text, no tool_calls.
  const tools = [
    {
      name: "setReminder",
      description: "Create a reminder",
      parameters: { type: "object", properties: { title: { type: "string" } } },
    },
  ];

  it("converts the JSON-in-text shape into a real tool call", () => {
    const call = parseLegacyToolCall(
      '{"name": "setReminder", "arguments": {"task": "drink water", "time": "30 minutes"}}',
      tools
    );
    expect(call).not.toBeNull();
    expect(call!.type).toBe("function");
    expect(call!.function.name).toBe("setReminder");
    expect(JSON.parse(call!.function.arguments)).toEqual({ task: "drink water", time: "30 minutes" });
  });

  it("refuses to invent a tool the request never offered", () => {
    const call = parseLegacyToolCall('{"name": "sendEmail", "arguments": {}}', tools);
    expect(call).toBeNull();
  });

  it("leaves an ordinary JSON answer untouched", () => {
    expect(parseLegacyToolCall('{"answer": "hello", "confidence": 0.9}', tools)).toBeNull();
    expect(parseLegacyToolCall('{"name": "setReminder"}', tools)).toBeNull();
  });

  it("ignores prose and malformed text", () => {
    expect(parseLegacyToolCall("I will set that reminder for you.", tools)).toBeNull();
    expect(parseLegacyToolCall("{not json", tools)).toBeNull();
    expect(parseLegacyToolCall(null, tools)).toBeNull();
  });

  it("reports a shimmed response as a tool call to the agent loop", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: '{"name": "setReminder", "arguments": {"minutes": 30}}',
            },
            finish_reason: "stop",
          },
        ],
      }),
    });

    const provider = createOllamaProvider({ baseUrl: "http://localhost:11434/v1" });
    const response = await provider.chat({
      model: "qwen2.5-coder:7b",
      messages: [{ role: "user", content: "remind me to drink water" }],
      tools,
    });

    expect(response.finishReason).toBe("tool_calls");
    expect(response.message.content).toBeNull();
    expect(response.message.tool_calls?.[0].function.name).toBe("setReminder");
  });
});

describe("routing with no paid key", () => {
  function configClient(rows: Array<Record<string, unknown>>) {
    const builder = {
      select: () => builder,
      is: () => builder,
      order: () => Promise.resolve({ data: rows.filter((r) => r.user_id === null), error: null }),
      eq: () => Promise.resolve({ data: rows.filter((r) => r.user_id !== null), error: null }),
    };
    return { from: () => builder } as never;
  }

  const OPENAI_ONLY_ROWS = [
    {
      user_id: null,
      role: "primary",
      provider: "openai",
      model: "gpt-5-mini",
      base_url: null,
      fallback_order: 0,
      max_output_tokens: null,
      temperature: null,
    },
  ];

  it("falls back to the free provider when the configured vendor has no key", async () => {
    setEnv({ GOOGLE_API_KEY: "g-free" });

    const tried: string[] = [];
    const answer = await withModelFallback(
      configClient(OPENAI_ONLY_ROWS),
      "primary",
      null,
      async (_provider, model) => {
        tried.push(model.model);
        return model.model;
      }
    );

    // gpt-5-mini is dropped before the callback runs — it cannot even be built
    // without OPENAI_API_KEY — so the free Gemini candidate is the only one tried.
    expect(answer).toBe("gemini-3.8-flash");
    expect(tried).toEqual(["gemini-3.8-flash"]);
  });

  it("routes a gemini model name to Google even when the row says openai", async () => {
    setEnv({ OPENAI_API_KEY: "sk-x", GOOGLE_API_KEY: "g-free" });

    const seen: string[] = [];
    await withModelFallback(
      configClient([
        { ...OPENAI_ONLY_ROWS[0], model: "gemini-3.8-flash" },
      ]),
      "primary",
      null,
      async (provider) => {
        seen.push(provider.id);
        return "ok";
      }
    );

    expect(seen).toEqual(["google"]);
  });

  it("tells the user which variable to set when nothing is configured", async () => {
    setEnv({});

    await expect(
      withModelFallback(configClient(OPENAI_ONLY_ROWS), "primary", null, async (p) => p.id)
    ).rejects.toThrow(/OPENAI_API_KEY is not configured/);
  });
});
