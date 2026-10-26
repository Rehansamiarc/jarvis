import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { withModelFallback } from "./model-manager";

const MAX_CHARS_PER_INPUT = 8_000;

/**
 * Embed text through the configured embedding model, with a hard dimension check.
 *
 * The dimension guard matters: silently writing a 3072-d vector into a vector(1536)
 * column fails at insert time with a confusing error, so we fail early with an
 * explanation of which setting to change.
 */
export async function embedTexts(
  db: SupabaseClient,
  userId: string,
  texts: string[]
): Promise<number[][]> {
  if (!texts.length) return [];

  const inputs = texts.map((t) => t.slice(0, MAX_CHARS_PER_INPUT));
  const vectors = await withModelFallback(
    db,
    "embedding",
    userId,
    async (provider, model) => provider.embed(inputs, model.model),
    { timeoutMs: 60_000 }
  );

  const expected = env().JARVIS_EMBEDDING_DIM ?? 1536;
  for (const v of vectors) {
    if (v.length !== expected) {
      throw new Error(
        `Embedding dimension mismatch: model returned ${v.length}-d vectors but the database ` +
          `column expects ${expected}-d. Set JARVIS_EMBEDDING_DIM=${v.length} and run a migration ` +
          `that widens the vector columns, or point JARVIS_EMBEDDING_MODEL at a ${expected}-d model.`
      );
    }
  }
  return vectors;
}

export async function embedText(db: SupabaseClient, userId: string, text: string): Promise<number[]> {
  const [first] = await embedTexts(db, userId, [text]);
  if (!first) throw new Error("Embedding provider returned no vector.");
  return first;
}
