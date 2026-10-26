import { describe, expect, it } from "vitest";

import { BrainError, createBrainClient, joinUrl } from "../../desktop/brain";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const cookie = "sb-a-token=abc; sb-r-token=def";

describe("joinUrl", () => {
  it("joins origin and path without doubling the slash", () => {
    expect(joinUrl("https://brain.test/", "/api/preferences")).toBe("https://brain.test/api/preferences");
    expect(joinUrl("https://brain.test", "api/preferences")).toBe("https://brain.test/api/preferences");
  });
});

describe("createBrainClient — session", () => {
  it("reports signed in with the account email", async () => {
    const seen: RequestInit[] = [];
    const client = createBrainClient({
      baseUrl: "https://brain.test",
      cookieHeader: cookie,
      fetchImpl: async (_url, init) => {
        seen.push(init as RequestInit);
        return jsonResponse({ preferences: { voice_name: "Zira" }, profile: { email: "me@example.com" } });
      },
    });

    const status = await client.session();
    expect(status).toMatchObject({ signedIn: true, reachable: true, email: "me@example.com" });

    // The session cookie is the credential — it must actually be sent, and never cached.
    const headers = new Headers(seen[0]?.headers);
    expect(headers.get("cookie")).toBe(cookie);
    expect(headers.get("cache-control")).toBe("no-store");
  });

  it("reports reachable-but-signed-out on 401", async () => {
    const client = createBrainClient({
      baseUrl: "https://brain.test",
      fetchImpl: async () => jsonResponse({ error: "Not signed in." }, 401),
    });
    const status = await client.session();
    expect(status).toMatchObject({ signedIn: false, reachable: true, email: null });
    expect(status.detail).toMatch(/not signed in/i);
  });

  it("surfaces a 503 as 'not configured' rather than a failure", async () => {
    const client = createBrainClient({
      baseUrl: "https://brain.test",
      fetchImpl: async () => jsonResponse({ error: "Missing Supabase environment." }, 503),
    });
    const status = await client.session();
    expect(status).toMatchObject({ reachable: true, signedIn: false });
    expect(status.detail).toContain("Missing Supabase environment.");
  });

  it("reports an unreachable brain without throwing", async () => {
    const client = createBrainClient({
      baseUrl: "https://brain.test",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const status = await client.session();
    expect(status).toMatchObject({ reachable: false, signedIn: false });
    expect(status.detail).toMatch(/could not reach/i);
  });
});

describe("createBrainClient — voice", () => {
  it("maps the voice settings onto the preferences schema the brain validates", async () => {
    let body: string | null = null;
    const client = createBrainClient({
      baseUrl: "https://brain.test",
      cookieHeader: cookie,
      fetchImpl: async (_url, init) => {
        body = String(init?.body ?? "");
        return jsonResponse({ ok: true });
      },
    });

    const result = await client.saveVoice({ name: "Zira", rate: 1.5, pitch: 0.95, language: "en-GB" });
    expect(result.persistedToBrain).toBe(true);
    expect(JSON.parse(String(body))).toEqual({
      voice_name: "Zira",
      speech_rate: 1.5,
      speech_pitch: 0.95,
      language: "en-GB",
    });
  });

  it("keeps the change locally and says so when signed out", async () => {
    const client = createBrainClient({
      baseUrl: "https://brain.test",
      fetchImpl: async () => jsonResponse({ error: "Not signed in." }, 401),
    });
    const result = await client.saveVoice({ name: null, rate: 1, pitch: 1, language: "en-US" });
    expect(result.persistedToBrain).toBe(false);
    expect(result.detail).toMatch(/saved locally/i);
    expect(result.detail).toMatch(/sign in/i);
  });
});

describe("createBrainClient — agent", () => {
  it("returns the reply text from the agent route", async () => {
    const client = createBrainClient({
      baseUrl: "https://brain.test",
      cookieHeader: cookie,
      fetchImpl: async (_url, init) => {
        expect(String(init?.body)).toBe(JSON.stringify({ message: "hello" }));
        return jsonResponse({ reply: "At your service." });
      },
    });
    await expect(client.runAgent("hello")).resolves.toMatchObject({ reply: "At your service." });
  });

  it("throws a typed error when the session is missing", async () => {
    const client = createBrainClient({
      baseUrl: "https://brain.test",
      fetchImpl: async () => jsonResponse({ error: "unauthorized" }, 401),
    });
    await expect(client.runAgent("hi")).rejects.toBeInstanceOf(BrainError);
  });

  it("propagates a brain-side failure message", async () => {
    const client = createBrainClient({
      baseUrl: "https://brain.test",
      cookieHeader: cookie,
      fetchImpl: async () => jsonResponse({ error: "Model unavailable." }, 503),
    });
    await expect(client.runAgent("hi")).rejects.toThrow("Model unavailable.");
  });
});
