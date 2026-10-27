import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { availability, env, normalizeSupabaseUrl, resetEnvCache } from "@/lib/env";

/**
 * Regression coverage for a real bug: a single malformed optional variable used to make
 * the whole parse fail, and `env()` then returned an empty object — silently disabling
 * every feature (AI, Supabase, OAuth) instead of just the one bad setting.
 */

beforeEach(() => {
  delete process.env.RESEND_FROM;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.NEXT_PUBLIC_APP_URL;
  resetEnvCache();
});

afterEach(() => {
  resetEnvCache();
});

describe("environment parsing", () => {
  it("treats an empty optional variable as unset rather than invalid", () => {
    process.env.RESEND_FROM = "";
    resetEnvCache();

    expect(env().RESEND_FROM).toBeUndefined();
    expect(availability().resend).toBe(false);
  });

  it("keeps every other variable when one is malformed", () => {
    process.env.NEXT_PUBLIC_APP_URL = "not-a-url";
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/v1";
    resetEnvCache();

    // The bad URL is dropped...
    expect(env().NEXT_PUBLIC_APP_URL).toBeUndefined();
    // ...and the healthy ones still configure their features.
    expect(env().OLLAMA_BASE_URL).toBe("http://localhost:11434/v1");
    expect(availability().ai).toBe(true);
  });

  it("reports AI as available for a local Ollama server with no API key at all", () => {
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/v1";
    delete process.env.OPENAI_API_KEY;
    resetEnvCache();

    expect(availability().ai).toBe(true);
    expect(env().OPENAI_API_KEY).toBeUndefined();
  });

  it("reports AI unavailable when nothing is configured", () => {
    expect(availability().ai).toBe(false);
  });

  it("still accepts a real OpenAI key", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    resetEnvCache();
    expect(availability().ai).toBe(true);
  });
});

/**
 * Regression coverage for a second real bug: the dashboard shows the project URL and
 * the REST endpoint next to each other, and copying the REST one turned every database
 * call into `/rest/v1/rest/v1/...` → `404 PGRST125 Invalid path specified`, while the
 * health endpoint still reported Supabase as *configured*.
 */
describe("Supabase URL normalisation", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    resetEnvCache();
  });

  it("strips the REST or auth endpoint suffix", () => {
    expect(normalizeSupabaseUrl("https://x.supabase.co/rest/v1/")).toBe("https://x.supabase.co");
    expect(normalizeSupabaseUrl("https://x.supabase.co/rest/v1")).toBe("https://x.supabase.co");
    expect(normalizeSupabaseUrl("https://x.supabase.co/auth/v1")).toBe("https://x.supabase.co");
    expect(normalizeSupabaseUrl("https://x.supabase.co/")).toBe("https://x.supabase.co");
  });

  it("keeps a self-hosted project subpath intact", () => {
    expect(normalizeSupabaseUrl("https://example.com/supabase")).toBe("https://example.com/supabase");
    expect(normalizeSupabaseUrl("https://example.com/supabase/rest/v1/")).toBe(
      "https://example.com/supabase"
    );
  });

  it("hands a normalised URL to every env() consumer", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefghijklmnop.supabase.co/rest/v1/";
    resetEnvCache();

    expect(env().NEXT_PUBLIC_SUPABASE_URL).toBe("https://abcdefghijklmnop.supabase.co");
  });
});
