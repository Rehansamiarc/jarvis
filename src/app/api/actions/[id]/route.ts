import { requireAuth, readJson, jsonError, jsonOk, ApiError } from "@/lib/api";
import { loadRuntimeContext } from "@/lib/agent/context";
import { evaluatePolicy } from "@/lib/permissions/policy";
import { initTools } from "@/lib/tools";
import { notify } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Confirmation gate (section 13).
 *
 * Approval re-runs the full policy check against the *current* permission mode and
 * connection state — approving does not bypass anything, it only supplies the consent
 * that was missing. The tool is executed once, under an atomic status transition, so a
 * double-click cannot send a message twice.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth();
    const { id } = await context.params;
    const body = await readJson<{ decision: "approve" | "deny" }>(request);
    const decision = body.decision;

    if (decision !== "approve" && decision !== "deny") {
      throw new ApiError('Body must contain decision: "approve" or "deny".', 400, "bad_request");
    }

    const { data: action, error } = await auth.db
      .from("pending_actions")
      .select("*")
      .eq("id", id)
      .eq("user_id", auth.userId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!action) throw new ApiError("That request no longer exists.", 404, "not_found");
    if (action.status !== "proposed") {
      throw new ApiError(
        `This request was already ${action.status}.`,
        409,
        "already_decided"
      );
    }
    if (new Date(action.expires_at as string).getTime() < Date.now()) {
      await auth.db
        .from("pending_actions")
        .update({ status: "expired", decided_at: new Date().toISOString() })
        .eq("id", id);
      throw new ApiError("This request expired before it was approved. Ask again to retry.", 410, "expired");
    }

    // Atomic claim: only one of N concurrent clicks wins.
    const { data: claimed, error: claimError } = await auth.db
      .from("pending_actions")
      .update({
        status: decision === "approve" ? "approved" : "denied",
        decided_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "proposed")
      .select("id")
      .maybeSingle();

    if (claimError) throw new Error(claimError.message);
    if (!claimed) throw new ApiError("This request was already handled.", 409, "already_decided");

    if (decision === "deny") {
      await auth.db.from("action_logs").insert({
        user_id: auth.userId,
        conversation_id: action.conversation_id,
        action_name: action.action_name,
        risk: action.risk,
        status: "denied",
        pending_action_id: action.id,
        request: action.payload,
      });
      await auth.db
        .from("pending_actions")
        .update({ status: "denied" })
        .eq("id", action.id);
      return jsonOk({ status: "denied", actionId: action.id });
    }

    // ------------------------------------------------------------------ execute
    const registry = initTools();
    const tool = registry.get(action.action_name as string);
    if (!tool) {
      await finishAsFailed(auth.db, action.id, `Tool "${action.action_name}" no longer exists.`);
      throw new ApiError("That action is no longer available in this version of JARVIS.", 410, "gone");
    }

    const validated = registry.validate(tool.name, (action.payload as { args?: unknown }).args ?? {});
    if (!validated.ok) {
      await finishAsFailed(auth.db, action.id, validated.error);
      throw new ApiError(`The stored arguments are invalid: ${validated.error}`, 422, "invalid_args");
    }

    const ctx = await loadRuntimeContext(auth.db, auth.userId);

    // Re-evaluate against current state — permissions may have changed since proposing.
    const policy = evaluatePolicy({
      mode: ctx.permissionMode,
      risk: tool.risk,
      toolRequiresApproval: tool.requiresApproval,
      requiresConnection: tool.requiresConnection ?? null,
      requiresAnyConnection: tool.requiresAnyConnection,
      connections: ctx.connections,
    });

    if (!policy.allowed) {
      await finishAsFailed(auth.db, action.id, policy.reason);
      throw new ApiError(policy.reason, 403, "forbidden");
    }

    const startedAt = Date.now();
    let result;
    try {
      result = await tool.execute(validated.value as never, {
        userId: auth.userId,
        db: auth.db,
        admin: auth.admin,
        conversationId: action.conversation_id as string | null,
        permissionMode: ctx.permissionMode,
        connections: ctx.connections,
        runId: action.id as string,
      });
    } catch (executionError) {
      const message = (executionError as Error).message;
      await finishAsFailed(auth.db, action.id, message);
      throw new ApiError(`The action failed: ${message}`, 502, "execution_failed");
    }

    const durationMs = Date.now() - startedAt;
    const status = result.ok ? "succeeded" : "failed";

    await auth.db
      .from("pending_actions")
      .update({
        status: result.ok ? "executed" : "failed",
        executed_at: new Date().toISOString(),
        result: (result.data ?? null) as never,
        error: result.error ?? null,
      })
      .eq("id", action.id);

    await auth.db.from("action_logs").insert({
      user_id: auth.userId,
      conversation_id: action.conversation_id,
      action_name: tool.name,
      risk: tool.risk,
      status,
      target: String(
        (result.data as Record<string, unknown> | undefined)?.to ??
          (result.data as Record<string, unknown> | undefined)?.link ??
          (result.data as Record<string, unknown> | undefined)?.id ??
          ""
      ),
      pending_action_id: action.id,
      request: (action.payload as { args?: unknown }).args as never,
      response: (result.data ?? null) as never,
      error: result.error ?? null,
      duration_ms: durationMs,
    });

    await auth.db.from("execution_logs").insert({
      user_id: auth.userId,
      run_id: action.id as string,
      conversation_id: action.conversation_id,
      step: 0,
      tool_name: tool.name,
      arguments: (action.payload as { args?: unknown }).args as never,
      status: result.ok ? "ok" : "error",
      output: (result.data ?? null) as never,
      validation_error: result.error ?? null,
      duration_ms: durationMs,
    });

    await notify(auth.db, auth.userId, {
      kind: "task",
      level: result.ok ? "success" : "error",
      title: result.ok ? `Completed: ${tool.name}` : `Failed: ${tool.name}`,
      body: result.error ?? (result.verified ? "Verified against the provider." : "Provider responded."),
      link: "/activity",
    });

    if (!result.ok) {
      return jsonOk({
        status: "failed",
        actionId: action.id,
        error: result.error ?? "The action did not complete.",
        data: result.data ?? null,
      });
    }

    return jsonOk({
      status: "executed",
      actionId: action.id,
      verified: result.verified ?? false,
      data: result.data ?? null,
      durationMs,
    });
  } catch (error) {
    return jsonError(error);
  }
}

async function finishAsFailed(
  db: import("@supabase/supabase-js").SupabaseClient,
  id: string,
  reason: string
): Promise<void> {
  await db
    .from("pending_actions")
    .update({ status: "failed", error: reason, decided_at: new Date().toISOString() })
    .eq("id", id);
}
