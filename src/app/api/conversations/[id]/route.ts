import { requireAuth, jsonError, jsonOk, readJson, ApiError } from "@/lib/api";
import { summarize } from "@/lib/ai/generate";
import { availability } from "@/lib/env";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth();
    const { id } = await context.params;

    const [conversation, messages] = await Promise.all([
      auth.db
        .from("conversations")
        .select("id, title, summary, created_at, last_message_at")
        .eq("id", id)
        .eq("user_id", auth.userId)
        .maybeSingle(),
      auth.db
        .from("messages")
        .select("id, role, content, tool_calls, created_at")
        .eq("conversation_id", id)
        .eq("user_id", auth.userId)
        .order("created_at", { ascending: true })
        .limit(500),
    ]);

    if (conversation.error) throw new Error(conversation.error.message);
    if (!conversation.data) throw new ApiError("Conversation not found.", 404, "not_found");

    return jsonOk({ conversation: conversation.data, messages: messages.data ?? [] });
  } catch (error) {
    return jsonError(error);
  }
}

const PatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  archive: z.boolean().optional(),
  summarize: z.boolean().optional(),
});

/**
 * PATCH — rename, archive, or explicitly summarise. Summarisation replaces the rolling
 * `summary` and records how many messages it covers, so old turns can be dropped from
 * context without losing what was decided in them.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth();
    const { id } = await context.params;
    const parsed = PatchSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new ApiError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        400,
        "validation"
      );
    }

    const patch: Record<string, unknown> = {};
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.archive !== undefined)
      patch.archived_at = parsed.data.archive ? new Date().toISOString() : null;

    if (parsed.data.summarize) {
      if (!availability().ai) throw new ApiError("AI is not configured.", 503, "not_configured");

      const { data: rows } = await auth.db
        .from("messages")
        .select("role, content, created_at")
        .eq("conversation_id", id)
        .eq("user_id", auth.userId)
        .order("created_at", { ascending: true })
        .limit(200);

      const transcript = (rows ?? [])
        .map((m) => `${m.role}: ${String(m.content).slice(0, 2000)}`)
        .join("\n");

      if (transcript.trim()) {
        const summary = await summarize(auth.db, auth.userId, transcript);
        patch.summary = summary;
        patch.summary_message_count = rows?.length ?? 0;
      }
    }

    if (!Object.keys(patch).length) return jsonOk({ updated: false });

    const { data, error } = await auth.db
      .from("conversations")
      .update(patch)
      .eq("id", id)
      .eq("user_id", auth.userId)
      .select("id, title, summary, archived_at")
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new ApiError("Conversation not found.", 404, "not_found");
    return jsonOk({ updated: true, conversation: data });
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
      .from("conversations")
      .delete()
      .eq("id", id)
      .eq("user_id", auth.userId)
      .select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new ApiError("Conversation not found.", 404, "not_found");
    return jsonOk({ deleted: id });
  } catch (error) {
    return jsonError(error);
  }
}
