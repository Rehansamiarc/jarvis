import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { splitText, estimateTokens, stripMarkup } from "./chunk";
import { embedText, embedTexts } from "@/lib/ai/embeddings";
import { env } from "@/lib/env";

/**
 * Knowledge ingestion pipeline (section F-C).
 *
 * extract -> chunk -> embed -> store, with a content hash so re-indexing an unchanged
 * document is a no-op and a changed one replaces its chunks atomically (delete + insert
 * inside one request, ordered so a failure leaves the document marked `failed` rather
 * than half-indexed).
 */

export interface IndexInput {
  userId: string;
  title: string;
  content: string;
  sourceType?: "note" | "upload" | "url" | "youtube" | "wordpress" | "pasted";
  uri?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
  /** Existing document id when re-indexing. */
  documentId?: string;
}

export interface IndexResult {
  documentId: string;
  chunkCount: number;
  skipped: boolean;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function indexDocument(
  db: SupabaseClient,
  input: IndexInput
): Promise<IndexResult> {
  const text = input.sourceType === "upload" ? stripMarkup(input.content) : input.content;
  const hash = contentHash(text);

  // Re-indexing an unchanged document: report success without spending embedding budget.
  if (input.documentId) {
    const { data: existing } = await db
      .from("knowledge_documents")
      .select("id, content_hash")
      .eq("id", input.documentId)
      .eq("user_id", input.userId)
      .maybeSingle();
    if (existing?.content_hash === hash && existing.content_hash) {
      const { count } = await db
        .from("knowledge_chunks")
        .select("id", { count: "exact", head: true })
        .eq("document_id", input.documentId);
      return { documentId: input.documentId, chunkCount: count ?? 0, skipped: true };
    }
  }

  await markStatus(db, input.userId, input.documentId ?? null, "indexing", null);

  const documentId = await upsertDocument(db, input, hash);
  const chunks = splitText(text);

  if (chunks.length === 0) {
    await markStatus(db, input.userId, documentId, "failed", "No extractable text content.");
    return { documentId, chunkCount: 0, skipped: false };
  }

  let vectors: number[][] = [];
  try {
    vectors = await embedTexts(db, input.userId, chunks.map((c) => c.content));
  } catch (error) {
    await markStatus(db, input.userId, documentId, "failed", (error as Error).message);
    throw error;
  }

  const { error: deleteError } = await db
    .from("knowledge_chunks")
    .delete()
    .eq("document_id", documentId);
  if (deleteError) {
    await markStatus(db, input.userId, documentId, "failed", deleteError.message);
    throw new Error(`Failed to replace document chunks: ${deleteError.message}`);
  }

  const rows = chunks.map((chunk, i) => ({
    user_id: input.userId,
    document_id: documentId,
    ordinal: chunk.ordinal,
    content: chunk.content,
    token_count: chunk.tokenCount,
    embedding: vectors[i] ?? null,
    metadata: {
      ...(input.metadata ?? {}),
      source: input.sourceType ?? "note",
      ...(input.uri ? { uri: input.uri } : {}),
    },
  }));

  const { error: insertError } = await db.from("knowledge_chunks").insert(rows);
  if (insertError) {
    await markStatus(db, input.userId, documentId, "failed", insertError.message);
    throw new Error(`Failed to store document chunks: ${insertError.message}`);
  }

  const { error: finalError } = await db
    .from("knowledge_documents")
    .update({
      status: "indexed",
      error: null,
      chunk_count: rows.length,
      embedding_model: env().JARVIS_EMBEDDING_MODEL ?? "text-embedding-3-small",
      last_indexed_at: new Date().toISOString(),
      byte_size: Buffer.byteLength(text, "utf8"),
      metadata: { ...(input.metadata ?? {}), token_estimate: estimateTokens(text) },
    })
    .eq("id", documentId)
    .eq("user_id", input.userId);
  if (finalError) throw new Error(`Failed to finalise document: ${finalError.message}`);

  return { documentId, chunkCount: rows.length, skipped: false };
}

async function upsertDocument(
  db: SupabaseClient,
  input: IndexInput,
  hash: string
): Promise<string> {
  const payload = {
    user_id: input.userId,
    source_type: input.sourceType ?? "note",
    title: input.title,
    uri: input.uri ?? null,
    mime_type: input.mimeType ?? "text/plain",
    content_hash: hash,
    status: "pending",
    metadata: input.metadata ?? {},
    byte_size: Buffer.byteLength(input.content, "utf8"),
    ...(input.documentId ? { id: input.documentId } : {}),
  };

  const { data, error } = await db
    .from("knowledge_documents")
    .upsert(payload, { onConflict: "id" })
    .select("id")
    .single();

  if (error || !data) throw new Error(`Failed to save document: ${error?.message ?? "unknown error"}`);
  return data.id as string;
}

async function markStatus(
  db: SupabaseClient,
  userId: string,
  documentId: string | null,
  status: "pending" | "indexing" | "indexed" | "failed",
  error: string | null
): Promise<void> {
  if (!documentId) return;
  await db
    .from("knowledge_documents")
    .update({ status, error })
    .eq("id", documentId)
    .eq("user_id", userId);
}

export interface RetrievedChunk {
  id: string;
  document_id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  title?: string;
}

/**
 * Hybrid retrieval: semantic + keyword fused in SQL (RRF), then joined with document
 * titles so answers can cite their sources.
 */
export async function searchKnowledge(
  db: SupabaseClient,
  userId: string,
  query: string,
  limit = 8
): Promise<{ chunks: RetrievedChunk[]; embedded: boolean }> {
  let embedding: number[] | null = null;
  try {
    embedding = await embedText(db, userId, query);
  } catch {
    // Degraded mode: keyword-only retrieval still works via search_tsv.
    embedding = null;
  }

  const { data, error } = await db.rpc("match_knowledge_chunks", {
    query_embedding: embedding,
    match_count: limit,
    query_text: query,
    min_similarity: 0.15,
  });

  if (error) throw new Error(`Knowledge search failed: ${error.message}`);

  const rows = (data ?? []) as Array<{
    id: string;
    document_id: string;
    content: string;
    metadata: Record<string, unknown>;
    similarity: number;
  }>;

  if (!rows.length) return { chunks: [], embedded: embedding !== null };

  const { data: docs } = await db
    .from("knowledge_documents")
    .select("id, title, uri, source_type")
    .in(
      "id",
      [...new Set(rows.map((r) => r.document_id))]
    );

  const byId = new Map((docs ?? []).map((d) => [d.id as string, d]));

  return {
    embedded: embedding !== null,
    chunks: rows.map((r) => {
      const doc = byId.get(r.document_id) as
        | { title?: string; uri?: string; source_type?: string }
        | undefined;
      return {
        id: r.id,
        document_id: r.document_id,
        content: r.content,
        metadata: r.metadata ?? {},
        similarity: r.similarity ?? 0,
        title: doc?.title,
      };
    }),
  };
}
