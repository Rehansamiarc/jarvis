import { requireAuth, jsonError, jsonOk, readJson, ApiError } from "@/lib/api";
import { indexDocument, searchKnowledge } from "@/lib/knowledge/index";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CreateSchema = z.object({
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(400_000).optional(),
  url: z.string().url().optional(),
  sourceType: z.enum(["note", "upload", "url", "youtube", "wordpress", "pasted"]).optional(),
}).refine((v) => Boolean(v.content || v.url), {
  message: "Either content or url is required",
});

/** GET /api/knowledge — list documents, or hybrid-search with ?q=. */
export async function GET(request: Request) {
  try {
    const auth = await requireAuth();
    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.trim();

    if (q) {
      const result = await searchKnowledge(auth.db, auth.userId, q, 8);
      return jsonOk({ mode: "search", ...result });
    }

    const { data, error } = await auth.db
      .from("knowledge_documents")
      .select("id, source_type, title, uri, status, error, chunk_count, byte_size, last_indexed_at, created_at, updated_at")
      .eq("user_id", auth.userId)
      .order("updated_at", { ascending: false })
      .limit(200);

    if (error) throw new Error(error.message);
    return jsonOk({ mode: "list", documents: data ?? [] });
  } catch (error) {
    return jsonError(error);
  }
}

/** POST /api/knowledge — index a note, or fetch and index an approved URL. */
export async function POST(request: Request) {
  try {
    const auth = await requireAuth();
    const parsed = CreateSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new ApiError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        400,
        "validation"
      );
    }
    const body = parsed.data;

    let content = body.content ?? "";
    let sourceType = body.sourceType ?? (body.url ? "url" : "note");
    const uri = body.url;

    if (body.url && !content) {
      // Fetch on the server: keeps the user's session out of arbitrary cross-origin
      // requests and lets us strip markup before chunking.
      const fetched = await fetch(body.url, {
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
        headers: { "user-agent": "JARVIS/1.0 (+knowledge indexer)" },
      });
      if (!fetched.ok) {
        throw new ApiError(`Could not fetch ${body.url}: HTTP ${fetched.status}`, 400, "fetch_failed");
      }
      const contentType = fetched.headers.get("content-type") ?? "";
      if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
        const html = await fetched.text();
        content = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, "\n")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/\n{3,}/g, "\n\n");
      } else {
        content = await fetched.text();
      }
      sourceType = "url";
    }

    if (!content.trim()) {
      throw new ApiError("No extractable text content.", 400, "empty");
    }

    const result = await indexDocument(auth.db, {
      userId: auth.userId,
      title: body.title,
      content,
      sourceType,
      uri,
      metadata: { indexedBy: "user" },
    });

    return jsonOk(result, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
