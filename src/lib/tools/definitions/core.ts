import { z } from "zod";
import { registry, defineTool } from "../registry";
import { searchMemories, saveMemory } from "@/lib/memory";
import { searchKnowledge, indexDocument } from "@/lib/knowledge/index";
import { webSearch } from "@/lib/integrations/search";
import { notify } from "@/lib/notify";
import { loadTools } from "../select";

const loadToolsDef = defineTool({
  name: "load_tools",
  description:
    "Make additional tools available for the rest of this request. Call this with the exact " +
    "tool names you need when a capability was listed as deferred. Returns which names are " +
    "available now and why any are not.",
  category: "system",
  risk: "read",
  schema: z.object({
    names: z
      .array(z.string())
      .min(1)
      .max(10)
      .describe("Tool names to load, e.g. ['wordpress.create_draft','youtube.videos']"),
  }),
  async execute(args, ctx) {
    const { available, unavailable } = loadTools(args.names, {
      mode: ctx.permissionMode,
      connections: ctx.connections,
    });
    ctx.onToolsLoaded?.(available);
    return {
      ok: unavailable.length === 0,
      data: { available, unavailable },
      error: unavailable.length
        ? `Not available: ${unavailable.map((u) => `${u.name} (${u.reason})`).join("; ")}`
        : undefined,
    };
  },
});

const memorySearch = defineTool({
  name: "memory.search",
  description:
    "Search long-term personal memories (preferences, projects, dates, goals) using semantic " +
    "and keyword matching. Use before answering questions about the user's history or preferences.",
  category: "memory",
  risk: "read",
  triggers: ["remember", "memory", "preference", "prefer", "who am i", "project", "goal", "birthday", "anniversary"],
  schema: z.object({
    query: z.string().min(1).describe("What to look for"),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async execute(args, ctx) {
    const rows = await searchMemories(ctx.db, ctx.userId, args.query, args.limit ?? 8);
    if (rows.length) {
      // Recency feedback so a memory that keeps proving useful surfaces higher later.
      await ctx.db
        .from("memories")
        .update({ last_accessed_at: new Date().toISOString() })
        .in(
          "id",
          rows.map((r) => r.id)
        );
    }
    return { ok: true, data: { count: rows.length, memories: rows } };
  },
});

const memorySave = defineTool({
  name: "memory.save",
  description:
    "Persist a durable fact, preference, project, goal or date so JARVIS recalls it in future " +
    "conversations. Only save information that is genuinely useful and explicitly stated.",
  category: "memory",
  risk: "write",
  triggers: ["remember that", "save this", "note that", "my name is", "i prefer", "i'm working on"],
  schema: z.object({
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(4000),
    kind: z
      .enum(["preference", "fact", "project", "date", "goal", "instruction", "other"])
      .optional()
      .describe("Classification of the memory"),
    pinned: z.boolean().optional().describe("Always include this memory in future prompts"),
  }),
  async execute(args, ctx) {
    const result = await saveMemory(ctx.db, ctx.userId, {
      title: args.title,
      content: args.content,
      kind: args.kind,
      source: "conversation",
      originRef: ctx.conversationId ?? undefined,
      pinned: args.pinned,
    });
    return { ok: true, verified: true, data: { id: result.id, embedded: result.embedded } };
  },
});

const knowledgeSearch = defineTool({
  name: "knowledge.search",
  description:
    "Search the personal knowledge base (indexed documents and notes) using hybrid semantic + " +
    "keyword retrieval. Returns verbatim chunks with their source document for citation.",
  category: "knowledge",
  risk: "read",
  triggers: ["document", "knowledge base", "my notes", "indexed", "pdf", "article", "according to"],
  schema: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async execute(args, ctx) {
    const result = await searchKnowledge(ctx.db, ctx.userId, args.query, args.limit ?? 6);
    return {
      ok: true,
      data: {
        count: result.chunks.length,
        semantic: result.embedded,
        sources: result.chunks.map((c) => ({
          title: c.title ?? "Untitled document",
          document_id: c.document_id,
          relevance: Number(c.similarity.toFixed(3)),
        })),
        chunks: result.chunks,
      },
    };
  },
});

const notesCreate = defineTool({
  name: "notes.create",
  description:
    "Save a note into the personal knowledge base. The note is chunked, embedded and becomes " +
    "searchable through knowledge.search.",
  category: "knowledge",
  risk: "write",
  triggers: ["write a note", "save a note", "take a note", "add to my knowledge"],
  schema: z.object({
    title: z.string().min(1).max(300),
    content: z.string().min(1).max(50_000),
    uri: z.string().url().optional().describe("Canonical URL if this note came from the web"),
  }),
  async execute(args, ctx) {
    const result = await indexDocument(ctx.db, {
      userId: ctx.userId,
      title: args.title,
      content: args.content,
      sourceType: args.uri ? "url" : "note",
      uri: args.uri,
    });
    return { ok: true, verified: true, data: result };
  },
});

const webSearchTool = defineTool({
  name: "web_search",
  description:
    "Search the public web and return titles, URLs and snippets. Use for current events, " +
    "facts you are unsure about, or anything after your knowledge cutoff. Always cite URLs.",
  category: "research",
  risk: "read",
  requiresConnection: "serper",
  triggers: ["search", "web", "latest", "current", "news", "today", "google", "look up"],
  schema: z.object({
    query: z.string().min(1).max(400),
    num_results: z.number().int().min(1).max(10).optional(),
  }),
  async execute(args) {
    const result = await webSearch(args.query, args.num_results ?? 6);
    return { ok: result.results.length > 0, data: result };
  },
});

const notifyTool = defineTool({
  name: "notify",
  description:
    "Raise an in-app notification for the user. Use when something needs their attention " +
    "after this conversation, or to confirm a background job finished.",
  category: "system",
  risk: "write",
  triggers: ["notify", "alert me", "tell me later"],
  schema: z.object({
    title: z.string().min(1).max(200),
    body: z.string().max(2000).optional(),
    level: z.enum(["info", "success", "warning", "error"]).optional(),
  }),
  async execute(args, ctx) {
    const id = await notify(ctx.db, ctx.userId, {
      title: args.title,
      body: args.body,
      level: args.level ?? "info",
      kind: "system",
    });
    return { ok: id !== null, verified: id !== null, data: { id } };
  },
});

const memoryDelete = defineTool({
  name: "memory.delete",
  description:
    "Permanently forget a stored memory by id. Use only when the user explicitly asks to " +
    "delete or correct something. Always confirms first.",
  category: "memory",
  risk: "high",
  requiresApproval: true,
  triggers: ["forget", "delete memory", "remove memory"],
  schema: z.object({ id: z.string().uuid() }),
  async execute(args, ctx) {
    const { data, error } = await ctx.db
      .from("memories")
      .delete()
      .eq("id", args.id)
      .eq("user_id", ctx.userId)
      .select("id");
    if (error) return { ok: false, error: error.message };
    if (!data?.length) return { ok: false, error: `No memory found with id ${args.id}` };
    return { ok: true, verified: true, data: { deleted: args.id } };
  },
});

export function registerCoreTools(): void {
  registry.registerAll([
    loadToolsDef,
    memorySearch,
    memorySave,
    memoryDelete,
    knowledgeSearch,
    notesCreate,
    webSearchTool,
    notifyTool,
  ]);
}
