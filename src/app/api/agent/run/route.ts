import type { ChatMessage } from "@/lib/ai/types";
import { requireAuth, readJson, jsonError, jsonOk, ApiError } from "@/lib/api";
import { loadRuntimeContext } from "@/lib/agent/context";
import { runAgent } from "@/lib/agent/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface RunBody {
  message: string;
  conversationId?: string;
}

const MAX_MESSAGE_CHARS = 12_000;

/**
 * Agent entry point. Persists the user turn, runs the controlled tool loop, then
 * persists exactly what the model said and what the tools returned — so the transcript
 * in the database matches reality rather than a rendering of it.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireAuth();
    const body = await readJson<RunBody>(request);

    const message = (body.message ?? "").trim();
    if (!message) throw new ApiError("Message body is empty.", 400, "bad_request");
    if (message.length > MAX_MESSAGE_CHARS) {
      throw new ApiError(
        `Message exceeds ${MAX_MESSAGE_CHARS} characters. Split it or attach it to the knowledge base.`,
        400,
        "too_long"
      );
    }

    const context = await loadRuntimeContext(auth.db, auth.userId);

    // ------------------------------------------------------------------ conversation
    let conversationId = body.conversationId ?? null;
    if (conversationId) {
      const { data: existing } = await auth.db
        .from("conversations")
        .select("id")
        .eq("id", conversationId)
        .eq("user_id", auth.userId)
        .maybeSingle();
      if (!existing) throw new ApiError("Conversation not found.", 404, "not_found");
    } else {
      const created = await auth.db
        .from("conversations")
        .insert({
          user_id: auth.userId,
          title: message.slice(0, 80) || "New conversation",
        })
        .select("id")
        .single();
      if (created.error) throw new Error(created.error.message);
      conversationId = created.data.id as string;
    }

    // ----------------------------------------------------------------------- history
    const { data: historyRows } = await auth.db
      .from("messages")
      .select("role, content, tool_calls, tool_call_id, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(60);

    const history: ChatMessage[] = (historyRows ?? [])
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as ChatMessage["role"],
        content: m.content ?? "",
        tool_calls: (m.tool_calls as ChatMessage["tool_calls"]) ?? undefined,
        tool_call_id: m.tool_call_id ?? undefined,
      }));

    // Persist the user turn before running so a crash mid-run still leaves a record.
    const userInsert = await auth.db.from("messages").insert({
      conversation_id: conversationId,
      user_id: auth.userId,
      role: "user",
      content: message,
    });
    if (userInsert.error) console.warn("[jarvis] failed to persist user message:", userInsert.error.message);

    // ------------------------------------------------------------------------- run
    const result = await runAgent({
      db: auth.db,
      admin: auth.admin,
      userId: auth.userId,
      conversationId: conversationId!,
      userMessage: message,
      history,
      permissionMode: context.permissionMode,
      personality: context.personality,
      language: context.language,
      timezone: context.timezone,
      connections: context.connections,
    });

    // ------------------------------------------------------------------- persistence
    const assistantInsert = await auth.db.from("messages").insert({
      conversation_id: conversationId,
      user_id: auth.userId,
      role: "assistant",
      content: result.reply,
      model: null,
      tool_calls:
        result.steps.length > 0
          ? {
              run_id: result.runId,
              loaded_tools: result.loadedTools,
              steps: result.steps,
            }
          : null,
    });
    if (assistantInsert.error) {
      console.warn("[jarvis] failed to persist assistant message:", assistantInsert.error.message);
    }

    await auth.db
      .from("conversations")
      .update({
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);

    return jsonOk({
      conversationId,
      reply: result.reply,
      runId: result.runId,
      steps: result.steps,
      pendingAction: result.pendingAction ?? null,
      toolCallCount: result.toolCallCount,
      finishReason: result.finishReason,
    });
  } catch (error) {
    return jsonError(error);
  }
}
