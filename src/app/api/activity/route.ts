import { requireAuth, jsonError, jsonOk } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Audit trail (section 12 / 13): what was attempted, whether the server allowed it, what
 * the provider actually returned, and how long it took.
 *
 * `?view=actions|executions|approvals|jobs|usage` selects one stream; the default
 * interleaves actions and executions by time so the timeline reads chronologically.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireAuth();
    const url = new URL(request.url);
    const view = url.searchParams.get("view") ?? "all";
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

    const [actions, executions, approvals, jobRows, usageRows] = await Promise.all([
      view === "all" || view === "actions"
        ? auth.db
            .from("action_logs")
            .select("id, action_name, target, risk, status, error, duration_ms, pending_action_id, created_at")
            .eq("user_id", auth.userId)
            .order("created_at", { ascending: false })
            .limit(limit)
        : Promise.resolve({ data: [], error: null }),
      view === "all" || view === "executions"
        ? auth.db
            .from("execution_logs")
            .select("id, run_id, step, tool_name, status, validation_error, duration_ms, created_at")
            .eq("user_id", auth.userId)
            .order("created_at", { ascending: false })
            .limit(limit)
        : Promise.resolve({ data: [], error: null }),
      view === "all" || view === "approvals"
        ? auth.db
            .from("pending_actions")
            .select("id, action_name, risk, title, preview, status, error, expires_at, decided_at, executed_at, created_at")
            .eq("user_id", auth.userId)
            .order("created_at", { ascending: false })
            .limit(limit)
        : Promise.resolve({ data: [], error: null }),
      view === "all" || view === "jobs"
        ? auth.db
            .from("scheduled_jobs")
            .select("id, kind, status, run_at, attempts, max_attempts, last_error, completed_at, created_at")
            .eq("user_id", auth.userId)
            .order("created_at", { ascending: false })
            .limit(limit)
        : Promise.resolve({ data: [], error: null }),
      view === "usage"
        ? auth.db
            .from("usage_logs")
            .select("id, provider, model, operation, input_tokens, output_tokens, cost_usd, latency_ms, created_at")
            .eq("user_id", auth.userId)
            .order("created_at", { ascending: false })
            .limit(limit)
        : Promise.resolve({ data: [], error: null }),
    ]);

    for (const r of [actions, executions, approvals, jobRows, usageRows]) {
      if (r.error) throw new Error(r.error.message);
    }

    const timeline = [
      ...(actions.data ?? []).map((a) => ({
        stream: "action" as const,
        at: a.created_at,
        id: a.id,
        name: a.action_name,
        status: a.status,
        risk: a.risk,
        target: a.target,
        detail: a.error,
        durationMs: a.duration_ms,
      })),
      ...(executions.data ?? []).map((e) => ({
        stream: "tool" as const,
        at: e.created_at,
        id: e.id,
        name: e.tool_name,
        status: e.status,
        risk: null as string | null,
        target: null as string | null,
        detail: e.validation_error,
        durationMs: e.duration_ms,
      })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1));

    return jsonOk({
      timeline: view === "usage" ? [] : timeline.slice(0, limit),
      actions: actions.data ?? [],
      executions: executions.data ?? [],
      approvals: approvals.data ?? [],
      jobs: jobRows.data ?? [],
      usage: usageRows.data ?? [],
    });
  } catch (error) {
    return jsonError(error);
  }
}
