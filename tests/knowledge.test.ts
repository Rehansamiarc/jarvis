import { describe, expect, it } from "vitest";
import { estimateTokens, splitText, stripMarkup } from "@/lib/knowledge/chunk";
import { contentHash } from "@/lib/knowledge";
import { fakeClient } from "./helpers";

const paragraph = (n: number) =>
  `Paragraph ${n}. ${"JARVIS keeps a durable record of decisions and preferences. ".repeat(6)}`;

describe("text chunking", () => {
  it("returns nothing for empty or whitespace input", () => {
    expect(splitText("")).toEqual([]);
    expect(splitText("   \n\n \t ")).toEqual([]);
  });

  it("keeps a short note as a single chunk", () => {
    const chunks = splitText("Remember: the WordPress site is hosted on Kinsta.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].ordinal).toBe(0);
    expect(chunks[0].content).toMatch(/Kinsta/);
  });

  it("splits long documents into ordered chunks with a size ceiling", () => {
    const chunks = splitText(Array.from({ length: 12 }, (_, i) => paragraph(i)).join("\n\n"));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0);
      // Target is 1000 chars; the hard ceiling is 1.6x before a forced flush.
      expect(chunk.content.length).toBeLessThanOrEqual(1700);
    }
  });

  it("carries an overlap so a fact on a boundary still matches", () => {
    const chunks = splitText(Array.from({ length: 6 }, (_, i) => paragraph(i)).join("\n\n"));
    for (let i = 1; i < chunks.length; i++) {
      const tail = chunks[i - 1].content.slice(-40);
      expect(chunks[i].content.includes(tail.slice(-20))).toBe(true);
    }
  });

  it("hard-wraps a wall of text that has no paragraph breaks", () => {
    const wall = "supercalifragilistic".repeat(600);
    const chunks = splitText(wall);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= 2000)).toBe(true);
  });

  it("normalises CRLF and collapses runs of blank lines", () => {
    const chunks = splitText("a\r\n\r\n\r\n\r\nb");
    expect(chunks[0].content).toBe("a\n\nb");
  });

  it("estimates tokens from length", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });
});

describe("markup stripping", () => {
  it("removes scripts, styles and tags but keeps the prose", () => {
    const html = `<html><head><style>p{color:red}</style><script>alert(1)</script></head>
      <body><h1>Title</h1><p>The site is &amp; stays up.</p></body></html>`;
    const text = stripMarkup(html);
    expect(text).not.toMatch(/<[a-z/]/i);
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("color:red");
    expect(text).toContain("The site is & stays up.");
  });
});

describe("content hashing", () => {
  it("is stable for identical content and changes with the text", () => {
    expect(contentHash("draft v1")).toBe(contentHash("draft v1"));
    expect(contentHash("draft v1")).not.toBe(contentHash("draft v2"));
    expect(contentHash("draft v1")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("re-indexing an unchanged document", () => {
  it("skips work when the stored hash matches, so embedding spend is not wasted", async () => {
    const { indexDocument } = await import("@/lib/knowledge");
    const text = "A note that has not changed.";
    const { client } = fakeClient((record) => {
      if (record.table === "knowledge_documents") {
        return { data: { id: "doc-1", content_hash: contentHash(text) }, error: null };
      }
      return { data: null, error: null, count: 3 };
    });

    const result = await indexDocument(client as never, {
      userId: "user-1",
      title: "Unchanged",
      content: text,
      documentId: "doc-1",
    });

    expect(result).toMatchObject({ documentId: "doc-1", chunkCount: 3, skipped: true });
  });

  it("scopes the idempotency check to the signed-in user", async () => {
    const { indexDocument } = await import("@/lib/knowledge");
    const { client, calls } = fakeClient((record) =>
      record.table === "knowledge_documents"
        ? { data: { id: "doc-9", content_hash: contentHash("x") }, error: null }
        : { data: null, error: null, count: 0 }
    );

    await indexDocument(client as never, {
      userId: "user-42",
      title: "Scoped",
      content: "x",
      documentId: "doc-9",
    });

    const scoped = calls.find((c) => c.table === "knowledge_documents")!;
    expect(scoped.filters).toContainEqual(["eq", "user_id", "user-42"]);
  });
});
