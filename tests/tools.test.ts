import { describe, expect, it } from "vitest";
import { initTools, registry, selectTools, loadTools } from "@/lib/tools";

const tools = initTools();

describe("tool registry integrity", () => {
  it("registers every capability exactly once (duplicate names would throw)", () => {
    expect(tools.names().length).toBeGreaterThanOrEqual(25);
    expect(() => initTools()).not.toThrow(); // idempotent
    expect(new Set(tools.names()).size).toBe(tools.names().length);
  });

  it("covers the required capability surface", () => {
    for (const name of [
      "web_search",
      "knowledge.search",
      "memory.search",
      "memory.save",
      "task.create",
      "reminder.create",
      "wordpress.search",
      "wordpress.create_draft",
      "youtube.channel",
      "message.send",
    ]) {
      expect(tools.has(name), `missing tool ${name}`).toBe(true);
    }
  });

  it("gives every tool a description, a category, a schema and a handler", () => {
    for (const tool of tools.list()) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.category.length).toBeGreaterThan(0);
      expect(typeof tool.execute).toBe("function");
      expect(tool.schema).toBeDefined();
      expect(["read", "write", "high"]).toContain(tool.risk);
    }
  });

  it("marks every mutating external action as high risk", () => {
    for (const name of ["wordpress.publish", "youtube.upload", "message.send"]) {
      expect(tools.get(name)!.risk).toBe("high");
    }
  });

  it("never exposes a tool that needs a connection without declaring it", () => {
    for (const name of ["wordpress.search", "youtube.videos", "message.send"]) {
      const tool = tools.get(name)!;
      expect(Boolean(tool.requiresConnection || tool.requiresAnyConnection?.length)).toBe(true);
    }
  });
});

describe("JSON schema generation", () => {
  it("emits an object schema with the real required fields", () => {
    const spec = tools.specs(["reminder.create"])[0];
    expect(spec.name).toBe("reminder.create");
    expect(spec.parameters).toMatchObject({ type: "object" });
    expect(spec.parameters.$schema).toBeUndefined();
    expect(Array.isArray(spec.parameters.required)).toBe(true);
    expect(spec.parameters.required as string[]).toContain("title");
  });

  it("skips unknown names instead of emitting an empty spec", () => {
    expect(tools.specs(["nope.not.a.tool"])).toHaveLength(0);
  });
});

describe("server-side argument validation", () => {
  it("accepts JSON string arguments, as models send them", () => {
    const result = registry.validate("reminder.create", JSON.stringify({ title: "Call the bank" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value as { title: string }).title).toBe("Call the bank");
  });

  it("treats an empty argument string as an empty object", () => {
    const result = registry.validate("reminder.list", "");
    expect(result.ok).toBe(true);
  });

  it("rejects malformed JSON with a usable message", () => {
    const result = registry.validate("reminder.create", "{title: ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not valid JSON/);
  });

  it("rejects missing required fields and names the field", () => {
    const result = registry.validate("reminder.create", "{}");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/title/);
  });

  it("rejects out-of-range values", () => {
    const result = registry.validate("web_search", { query: "", numResults: 500 });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown tools rather than silently running something else", () => {
    const result = registry.validate("wordpress.delete_everything", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unknown tool/);
  });
});

describe("task-driven tool selection", () => {
  const allConnected = {
    wordpress: "connected",
    youtube: "connected",
    gmail: "connected",
    serper: "connected",
    resend: "connected",
  };

  it("loads WordPress tools for a WordPress request", () => {
    const { loaded } = selectTools({
      mode: "auto_low_risk",
      connections: allConnected,
      intent: "draft a new blog post on my WordPress site about AI",
    });
    expect(loaded).toContain("wordpress.search");
    expect(loaded).toContain("wordpress.create_draft");
  });

  it("does not ship WordPress tools for an unrelated request", () => {
    const { loaded, deferred } = selectTools({
      mode: "auto_low_risk",
      connections: allConnected,
      intent: "remind me to call my sister tomorrow",
    });
    expect(loaded).not.toContain("wordpress.create_draft");
    expect(deferred.map((d) => d.name)).toContain("wordpress.create_draft");
  });

  it("stays inside the tool budget", () => {
    const { loaded } = selectTools({
      mode: "auto_low_risk",
      connections: allConnected,
      intent: "wordpress youtube email research everything at once",
      budget: 8,
    });
    expect(loaded.length).toBeLessThanOrEqual(8);
  });

  it("never offers a mutation in read-only mode", () => {
    const { loaded, deferred } = selectTools({
      mode: "read_only",
      connections: allConnected,
      intent: "publish a post to my blog and upload a youtube video",
    });
    const offered = [...loaded, ...deferred.map((d) => d.name)];
    for (const name of offered) {
      expect(tools.get(name)!.risk, `${name} leaked into read-only mode`).toBe("read");
    }
  });
});

describe("deferred tool loading", () => {
  it("grants connected tools and leaves approval to the executor", () => {
    const { available, unavailable } = loadTools(["wordpress.search", "wordpress.publish"], {
      mode: "auto_low_risk",
      connections: { wordpress: "connected" },
    });

    // Loading is not permission: a high-risk tool may be advertised, but the policy
    // engine still stops it at execution for confirmation.
    expect(available).toEqual(["wordpress.search", "wordpress.publish"]);
    expect(unavailable).toHaveLength(0);
    expect(tools.get("wordpress.publish")!.risk).toBe("high");
  });

  it("refuses to load a mutation at all in read-only mode", () => {
    const blocked = loadTools(["wordpress.publish"], {
      mode: "read_only",
      connections: { wordpress: "connected" },
    });
    expect(blocked.available).toHaveLength(0);
    expect(blocked.unavailable[0].reason).toMatch(/Read-only/);
  });

  it("explains a missing connection instead of pretending the tool ran", () => {
    const { unavailable } = loadTools(["youtube.videos"], {
      mode: "auto_low_risk",
      connections: {},
    });
    expect(unavailable[0].reason).toMatch(/youtube/i);
  });

  it("caps a single load_tools request", () => {
    const names = Array.from({ length: 40 }, () => "memory.search");
    expect(loadTools(names, { mode: "auto_low_risk", connections: {} }).available).toHaveLength(20);
  });
});
