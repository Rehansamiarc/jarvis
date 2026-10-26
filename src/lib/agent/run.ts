import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatMessage, ToolSpec } from "@/lib/ai/types";
import { withModelFallback } from "@/lib/ai/model-manager";
import { logUsage } from "@/lib/ai/usage";
import { evaluatePolicy, type PermissionMode } from "@/lib/permissions/policy";
import { initTools } from "@/lib/tools";
import { selectTools, loadTools } from "@/lib/tools/select";
import type { ToolContext } from "@/lib/tools/registry";
import { buildSystemPrompt, selectHistory } from "./prompt";
import { searchMemories } from "@/lib/memory";
import { searchKnowledge } from "@/lib/knowledge/index";

/**
 * Controlled agent loop (section 12 / F-E).
 *
 * Per iteration: model proposes tool calls -> server validates schema -> server decides
 * permission (independently of the model) -> execute with a timeout -> record the real
 * result -> feed it back. The model never touches SQL, never runs code, and never gets
 * to declare its own actions successful.
 */

const MAX_STEPS = 6;
const MAX_CALLS_PER_STEP = 4;
const TOOL_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

export interface AgentStepLog {
  tool: string;
  status: "ok" | "rejected" | "error" | "awaiting_approval";
  detail?: string;
  durationMs?: number;
  verified?: boolean;
}

export interface PendingActionInfo {
  id: string;
  actionName: string;
  risk: string;
  title: string;
  preview: Record<string, unknown>;
  expiresAt: string;
}

export interface AgentResult {
  reply: string;
  runId: string;
  steps: AgentStepLog[];
  loadedTools: string[];
  toolCallCount: number;
  finishReason: "stop" | "max_steps" | "error";
  pendingAction?: PendingActionInfo;
  error?: string;
}

export interface AgentInput {
  db: SupabaseClient;
  admin: SupabaseClient | null;
  userId: string;
  conversationId: string;
  userMessage: string;
  history: ChatMessage[];
  permissionMode: PermissionMode;
  personality: string;
  language: string;
  timezone: string;
  connections: Record<string, string>;
  signal?: AbortSignal;
}

async function hasRows(db: SupabaseClient, table: string, userId: string): Promise<boolean> {
  const { count } = await db
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .limit(1);
  return (count ?? 0) > 0;
}

async function logExecution(
  db: SupabaseClient,
  input: {
    userId: string;
    runId: string;
    conversationId: string;
    step: number;
    toolName: string;
    args: unknown;
    status: "ok" | "rejected" | "error" | "timeout";
    validationError?: string;
    output?: unknown;
    durationMs?: number;
  }
): Promise<void> {
  const { error } = await db.from("execution_logs").insert({
    user_id: input.userId,
    run_id: input.runId,
    conversation_id: input.conversationId,
    step: input.step,
    tool_name: input.toolName,
    arguments: input.args as never,
    status: input.status,
    validation_error: input.validationError ?? null,
    output: (input.output ?? null) as never,
    duration_ms: input.durationMs ?? null,
  });
  if (error) console.warn("[jarvis] execution_logs insert failed:", error.message);
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const registry = initTools();
  const runId = randomUUID();
  const steps: AgentStepLog[] = [];
  const blocked = new Set<string>();
  let pendingAction: PendingActionInfo | undefined;
  let toolCallCount = 0;

  const ctx: ToolContext = {
    userId: input.userId,
    db: input.db,
    admin: input.admin,
    conversationId: input.conversationId,
    permissionMode: input.permissionMode,
    connections: input.connections,
    runId,
    signal: input.signal,
  };

  // ---------------------------------------------------------------- context assembly
  const memories = (await hasRows(input.db, "memories", input.userId))
    ? await searchMemories(input.db, input.userId, input.userMessage, 8)
    : [];

  const knowledge = (await hasRows(input.db, "knowledge_documents", input.userId))
    ? await searchKnowledge(input.db, input.userId, input.userMessage, 5)
    : { chunks: [], embedded: false };

  const selection = selectTools({
    mode: input.permissionMode,
    connections: input.connections,
    intent: input.userMessage,
  });

  const activeTools = new Set(selection.loaded);

  const { data: conversation } = await input.db
    .from("conversations")
    .select("summary, summary_message_count, title")
    .eq("id", input.conversationId)
    .maybeSingle();

  const systemPrompt = buildSystemPrompt({
    personality: input.personality,
    language: input.language,
    now: new Date(),
    timezone: input.timezone,
    permissionMode: input.permissionMode,
    connections: input.connections,
    memories,
    knowledge: knowledge.chunks.map((c) => ({
      title: c.title ?? "Untitled",
      content: c.content,
      similarity: c.similarity,
    })),
    deferred: selection.deferred,
    conversationSummary: conversation?.summary ?? null,
    availableTools: [...activeTools],
  });

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...selectHistory(input.history),
    { role: "user", content: input.userMessage },
  ];

  const specFor = (): ToolSpec[] => registry.specs([...activeTools]);

  // ------------------------------------------------------------------------ the loop
  let finishReason: AgentResult["finishReason"] = "stop";
  let reply = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    if (input.signal?.aborted) {
      finishReason = "error";
      reply = "The run was cancelled before it finished.";
      break;
    }

    let response;
    try {
      response = await withModelFallback(
        input.db,
        "primary",
        input.userId,
        async (provider, model) =>
          provider.chat({
            model: model.model,
            messages,
            tools: specFor(),
            temperature: 0.4,
            maxOutputTokens: 1600,
            timeoutMs: 60_000,
            signal: input.signal,
          }),
        { needTools: true, timeoutMs: 60_000 }
      );
    } catch (error) {
      finishReason = "error";
      reply =
        `I could not complete that: ${(error as Error).message}`;
      break;
    }

    await logUsage(input.db, input.userId, {
      provider: "openai",
      model: response.model,
      operation: "chat",
      usage: response.usage,
      latencyMs: response.latencyMs,
      conversationId: input.conversationId,
    });

    messages.push(response.message);
    const calls = response.message.tool_calls ?? [];

    if (!calls.length) {
      reply = response.message.content?.trim() ?? "";
      finishReason = "stop";
      break;
    }

    if (step === MAX_STEPS - 1) {
      // Last iteration: do not execute more work, just tell the user what was planned.
      finishReason = "max_steps";
      reply =
        `I reached my execution limit for a single run after ${toolCallCount} tool call(s), so I stopped ` +
        `rather than continue without oversight. Here is what I did so far and what remains:\n\n` +
        steps.map((s) => `- \`${s.tool}\`: ${s.status}${s.detail ? ` — ${s.detail}` : ""}`).join("\n");
      messages.push({ role: "assistant", content: reply });
      break;
    }

    for (const call of calls.slice(0, MAX_CALLS_PER_STEP)) {
      toolCallCount++;
      const name = call.function.name;
      const argsText = call.function.arguments ?? "{}";

      const pushToolResult = (content: string) =>
        messages.push({ role: "tool", tool_call_id: call.id, content });

      if (blocked.has(name)) {
        await logExecution(input.db, {
          userId: input.userId,
          runId,
          conversationId: input.conversationId,
          step,
          toolName: name,
          args: safeParse(argsText),
          status: "rejected",
          validationError: "Tool already has an action awaiting user approval in this run.",
        });
        pushToolResult(
          JSON.stringify({
            ok: false,
            error: "This tool already has an action awaiting the user's approval. Wait for the result; do not call it again this run.",
          })
        );
        continue;
      }

      // 1. Schema validation — model output is untrusted input.
      const validated = registry.validate(name, safeParse(argsText));
      if (!validated.ok) {
        steps.push({ tool: name, status: "rejected", detail: validated.error });
        await logExecution(input.db, {
          userId: input.userId,
          runId,
          conversationId: input.conversationId,
          step,
          toolName: name,
          args: safeParse(argsText),
          status: "rejected",
          validationError: validated.error,
        });
        pushToolResult(JSON.stringify({ ok: false, error: validated.error }));
        continue;
      }
      const args = validated.value as Record<string, unknown>;
      const tool = registry.get(name)!;

      // 2. Permission decision — made here, not by the model.
      const decision = evaluatePolicy({
        mode: input.permissionMode,
        risk: tool.risk,
        toolRequiresApproval: tool.requiresApproval,
        requiresConnection: tool.requiresConnection ?? null,
        requiresAnyConnection: tool.requiresAnyConnection,
        connections: input.connections,
      });

      if (!decision.allowed) {
        steps.push({ tool: name, status: "rejected", detail: decision.reason });
        await logExecution(input.db, {
          userId: input.userId,
          runId,
          conversationId: input.conversationId,
          step,
          toolName: name,
          args,
          status: "rejected",
          validationError: decision.reason,
        });
        pushToolResult(JSON.stringify({ ok: false, error: decision.reason, code: decision.code }));
        continue;
      }

      // 3. Approval gate for consequential actions.
      if (decision.requiresApproval) {
        const preview = await buildPreview(tool.name, args, ctx);
        const created = await createPendingAction(input, {
          actionName: name,
          risk: tool.risk,
          title: typeof preview.title === "string" ? preview.title : humanize(name),
          preview,
          args,
        });
        if (created) {
          pendingAction = created;
          blocked.add(name);
          steps.push({ tool: name, status: "awaiting_approval", detail: created.title });
          pushToolResult(
            JSON.stringify({
              ok: false,
              awaiting_approval: true,
              pending_action_id: created.id,
              message:
                "The action was prepared and is waiting for the user's explicit confirmation. " +
                "Explain precisely what will happen and stop. Do not retry this tool.",
            })
          );
          continue;
        }
        // Could not persist the approval record — refuse rather than run unguarded.
        steps.push({ tool: name, status: "rejected", detail: "Could not create the approval record." });
        pushToolResult(JSON.stringify({ ok: false, error: "Could not create an approval record; the action was not run." }));
        continue;
      }

      // 4. Execute with a timeout, then record what actually happened.
      const started = Date.now();
      const timeoutMs = /upload/.test(name) ? UPLOAD_TIMEOUT_MS : TOOL_TIMEOUT_MS;
      try {
        const result = await withTimeout(tool.execute(args, ctx), timeoutMs, name);
        const durationMs = Date.now() - started;
        steps.push({
          tool: name,
          status: result.ok ? "ok" : "error",
          detail: result.error,
          durationMs,
          verified: result.verified,
        });
        await logExecution(input.db, {
          userId: input.userId,
          runId,
          conversationId: input.conversationId,
          step,
          toolName: name,
          args,
          status: result.ok ? "ok" : "error",
          output: result.data as never,
          validationError: result.error,
          durationMs,
        });
        pushToolResult(
          JSON.stringify({
            ok: result.ok,
            verified: result.verified ?? undefined,
            data: result.data,
            error: result.error,
          })
        );
      } catch (error) {
        const durationMs = Date.now() - started;
        const message = (error as Error).message;
        const timedOut = /timed out/i.test(message);
        steps.push({ tool: name, status: "error", detail: message, durationMs });
        await logExecution(input.db, {
          userId: input.userId,
          runId,
          conversationId: input.conversationId,
          step,
          toolName: name,
          args,
          status: timedOut ? "timeout" : "error",
          validationError: message,
          durationMs,
        });
        pushToolResult(
          JSON.stringify({
            ok: false,
            error: timedOut
              ? `Tool "${name}" timed out after ${timeoutMs}ms. The action may or may not have been applied — verify before reporting success.`
              : message,
          })
        );
      }
    }
  }

  if (!reply) {
    reply =
      finishReason === "max_steps"
        ? reply
        : "I was unable to produce a response. Please check the activity log for details.";
  }

  return {
    reply,
    runId,
    steps,
    loadedTools: [...activeTools],
    toolCallCount,
    finishReason,
    pendingAction,
    error: finishReason === "error" ? reply : undefined,
  };
}

// ------------------------------------------------------------------------------ helpers

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function humanize(toolName: string): string {
  return toolName
    .split(".")
    .join(" ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tool "${label}" timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function buildPreview(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<Record<string, unknown>> {
  const tool = initTools().get(toolName);
  const base: Record<string, unknown> = { action: toolName, ...args };
  if (!tool?.preview) return base;
  try {
    return { ...(await tool.preview(args as never, ctx)) };
  } catch (error) {
    return { ...base, preview_error: (error as Error).message };
  }
}

async function createPendingAction(
  input: AgentInput,
  data: {
    actionName: string;
    risk: string;
    title: string;
    preview: Record<string, unknown>;
    args: Record<string, unknown>;
  }
): Promise<PendingActionInfo | null> {
  const { data: row, error } = await input.db
    .from("pending_actions")
    .insert({
      user_id: input.userId,
      conversation_id: input.conversationId,
      action_name: data.actionName,
      risk: data.risk,
      title: data.title,
      preview: data.preview as never,
      payload: { args: data.args } as never,
      status: "proposed",
    })
    .select("id, action_name, risk, title, preview, expires_at")
    .single();

  if (error || !row) {
    console.warn("[jarvis] pending_actions insert failed:", error?.message);
    return null;
  }

  await input.db.from("action_logs").insert({
    user_id: input.userId,
    conversation_id: input.conversationId,
    action_name: data.actionName,
    risk: data.risk as never,
    status: "proposed",
    target: String(data.preview.to ?? data.preview.post_id ?? data.preview.title ?? ""),
    pending_action_id: row.id,
    request: data.args as never,
  });

  return {
    id: row.id as string,
    actionName: row.action_name as string,
    risk: row.risk as string,
    title: row.title as string,
    preview: row.preview as Record<string, unknown>,
    expiresAt: row.expires_at as string,
  };
}

/** Used by the approval route so tool loading rules still apply after confirmation. */
export function canRunAfterApproval(
  permissionMode: PermissionMode,
  connections: Record<string, string>,
  names: string[]
): { available: string[]; unavailable: Array<{ name: string; reason: string }> } {
  return loadTools(names, { mode: permissionMode, connections });
}
