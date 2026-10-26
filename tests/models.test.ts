import { beforeEach, describe, expect, it } from "vitest";
import { inferCapabilities } from "@/lib/ai/types";
import {
  invalidateModelConfigCache,
  ProviderError,
  withModelFallback,
} from "@/lib/ai/model-manager";
import { resetEnvCache } from "@/lib/env";

const ROWS = [
  { user_id: null, role: "primary", provider: "openai", model: "gpt-5-mini", base_url: null, fallback_order: 0, max_output_tokens: null, temperature: null },
  { user_id: null, role: "coding", provider: "openai", model: "gpt-5", base_url: null, fallback_order: 1, max_output_tokens: null, temperature: null },
];

function configClient(rows = ROWS) {
  const builder = {
    select: () => builder,
    is: () => builder,
    order: () => Promise.resolve({ data: rows.filter((r) => r.user_id === null), error: null }),
    eq: () => Promise.resolve({ data: rows.filter((r) => r.user_id !== null), error: null }),
  };
  return { from: () => builder } as never;
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  delete process.env.JARVIS_MODEL_PRIMARY;
  delete process.env.JARVIS_MODEL_CODING;
  resetEnvCache();
  invalidateModelConfigCache();
});

describe("capability inference", () => {
  it("knows embedding models cannot call tools", () => {
    expect(inferCapabilities("text-embedding-3-small")).toEqual({
      tools: false,
      json: false,
      vision: false,
    });
  });

  it("knows which chat models support tools, structured output and vision", () => {
    expect(inferCapabilities("gpt-5")).toEqual({ tools: true, json: true, vision: true });
    expect(inferCapabilities("gpt-4-turbo")).toEqual({ tools: true, json: true, vision: true });
    expect(inferCapabilities("claude-3-5-sonnet").json).toBe(false);
  });

  it("does not assume an unknown model supports modalities", () => {
    expect(inferCapabilities("some-new-model-v1")).toEqual({
      tools: true,
      json: false,
      vision: false,
    });
  });
});

describe("fallback handling", () => {
  it("falls through to the next candidate when a provider is rate-limited", async () => {
    const tried: string[] = [];
    const result = await withModelFallback(
      configClient(),
      "coding",
      null,
      async (_provider, model) => {
        tried.push(model.model);
        if (tried.length === 1) throw new ProviderError("429 rate limit", 429, true, model.model);
        return `answered by ${model.model}`;
      }
    );

    expect(tried).toEqual(["gpt-5", "gpt-5-mini"]);
    expect(result).toBe("answered by gpt-5-mini");
  });

  it("never hands a tool-calling request to an embedding model", async () => {
    const tried: string[] = [];
    const result = await withModelFallback(
      configClient(),
      "embedding",
      null,
      async (_provider, model) => {
        tried.push(model.model);
        return model.model;
      },
      { needTools: true }
    );

    // text-embedding-3-small is first in the chain but cannot call tools, so the
    // conversational fallback answers instead.
    expect(tried).toEqual(["gpt-5-mini"]);
    expect(result).toBe("gpt-5-mini");
  });

  it("rethrows a genuine request error instead of blaming the next model", async () => {
    const tried: string[] = [];
    await expect(
      withModelFallback(configClient(), "primary", null, async (_provider, model) => {
        tried.push(model.model);
        throw new Error("400 invalid request: messages[0] too long");
      })
    ).rejects.toThrow(/too long/);
    expect(tried).toEqual(["gpt-5-mini"]);
  });

  it("reports every candidate when the whole chain is unavailable", async () => {
    const client = configClient(ROWS.filter((r) => r.role === "primary"));
    await expect(
      withModelFallback(client, "primary", null, async () => {
        throw new ProviderError("502 upstream", 502, true, "gpt-5-mini");
      })
    ).rejects.toThrow(/No available model|502/);
  });

  it("refuses to build a provider without an API key, with an actionable message", async () => {
    delete process.env.OPENAI_API_KEY;
    resetEnvCache();
    invalidateModelConfigCache();

    await expect(
      withModelFallback(configClient(), "primary", null, async (_p, model) => model.model)
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });
});
