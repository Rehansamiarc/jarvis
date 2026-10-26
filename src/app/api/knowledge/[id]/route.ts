import { requireAuth, jsonError, jsonOk, ApiError } from "@/lib/api";
import { indexDocument } from "@/lib/knowledge/index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST — re-index a stored document. DELETE — remove it and all of its chunks. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth();
    const { id } = await context.params;

    const { data: doc, error } = await auth.db
      .from("knowledge_documents")
      .select("id, title, uri, metadata, source_type")
      .eq("id", id)
      .eq("user_id", auth.userId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!doc) throw new ApiError("Document not found.", 404, "not_found");

    // Re-extract from the original source when we have one; otherwise the stored content
    // hash makes this a cheap no-op if nothing changed.
    let content = "";
    if (doc.uri) {
      try {
        const fetched = await fetch(doc.uri, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
        if (fetched.ok) {
          const text = await fetched.text();
          content = text.replace(/<[^>]+>/g, "\n").replace(/\n{3,}/g, "\n\n");
        }
      } catch {
        content = "";
      }
    }

    if (!content) {
      // No remote source: read the existing chunks back and rebuild from them.
      const { data: chunks } = await auth.db
        .from("knowledge_chunks")
        .select("content")
        .eq("document_id", id)
        .order("ordinal", { ascending: true });
      content = (chunks ?? []).map((c) => c.content as string).join("\n\n");
    }

    if (!content.trim()) throw new ApiError("No content available to re-index.", 400, "empty");

    const result = await indexDocument(auth.db, {
      userId: auth.userId,
      title: doc.title,
      content,
      sourceType: (doc.source_type as never) ?? "note",
      uri: doc.uri ?? undefined,
      documentId: id,
    });

    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth();
    const { id } = await context.params;

    const { data, error } = await auth.db
      .from("knowledge_documents")
      .delete()
      .eq("id", id)
      .eq("user_id", auth.userId)
      .select("id");

    if (error) throw new Error(error.message);
    if (!data?.length) throw new ApiError("Document not found.", 404, "not_found");
    return jsonOk({ deleted: id });
  } catch (error) {
    return jsonError(error);
  }
}
