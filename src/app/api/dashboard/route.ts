import { requireAuth, jsonError, jsonOk } from "@/lib/api";
import { loadRuntimeContext } from "@/lib/agent/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One aggregate call for the dashboard (section 15). Everything here is read through the
 * caller's RLS-scoped client, so a forged request can still only see its own account.
 */
export async function GET() {
  try {
    const auth = await requireAuth();
    const userId = auth.userId;

    const [
      profile,
      preferences,
      conversations,
      tasks,
      reminders,
      automations,
      actions,
      failures,
      integrations,
      notifications,
      pending,
      usage,
      jobs,
    ] = await Promise.all([
      auth.db.from("profiles").select("email, full_name, timezone").eq("id", userId).maybeSingle(),
      auth.db.from("user_preferences").select("permission_mode, automations_paused, personality").eq("user_id", userId).maybeSingle(),
      auth.db
        .from("conversations")
        .select("id, title, last_message_at, updated_at")
        .eq("user_id", userId)
        .is("archived_at", null)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(5),
      auth.db
        .from("tasks")
        .select("id, title, status, priority, created_at, finished_at")
        .eq("user_id", userId)
        .in("status", ["pending", "running"])
        .order("created_at", { ascending: false })
        .limit(8),
      auth.db
        .from("reminders")
        .select("id, title, due_at, timezone, status, rrule, note")
        .eq("user_id", userId)
        .in("status", ["pending", "snoozed"])
        .order("due_at", { ascending: true })
        .limit(8),
      auth.db
        .from("automation_rules")
        .select("id, name, enabled, last_run_at, last_error, run_count")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(8),
      auth.db
        .from("action_logs")
        .select("id, action_name, target, risk, status, error, duration_ms, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(10),
      auth.db
        .from("execution_logs")
        .select("id, tool_name, status, validation_error, duration_ms, created_at")
        .eq("user_id", userId)
        .in("status", ["error", "rejected", "timeout"])
        .order("created_at", { ascending: false })
        .limit(8),
      auth.db
        .from("integrations")
        .select("provider, status, last_error, last_checked_at, connected_at")
        .eq("user_id", userId),
      auth.db
        .from("notifications")
        .select("id, kind, level, title, body, link, created_at, read_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(15),
      auth.db
        .from("pending_actions")
        .select("id, action_name, risk, title, preview, expires_at, created_at, status")
        .eq("user_id", userId)
        .eq("status", "proposed")
        .order("created_at", { ascending: false })
        .limit(5),
      auth.db
        .from("usage_logs")
        .select("operation, model, input_tokens, output_tokens, cost_usd, created_at")
        .eq("user_id", userId)
        .gte("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString())
        .limit(500),
      auth.db
        .from("scheduled_jobs")
        .select("id, kind, status, run_at, attempts, last_error")
        .eq("user_id", userId)
        .in("status", ["scheduled", "claimed", "running", "failed", "dead"])
        .order("run_at", { ascending: true })
        .limit(20),
    ]);

    const context = await loadRuntimeContext(auth.db, userId);

    const usageRows = usage.data ?? [];
    const usageSummary = usageRows.reduce(
      (acc, row) => {
        acc.inputTokens += row.input_tokens ?? 0;
        acc.outputTokens += row.output_tokens ?? 0;
        acc.costUsd += Number(row.cost_usd ?? 0);
        acc.calls += 1;
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }
    );
    usageSummary.costUsd = Number(usageSummary.costUsd.toFixed(4));

    const now = Date.now();
    const todayIso = new Date(now).toISOString().slice(0, 10);

    return jsonOk({
      profile: profile.data,
      preferences: preferences.data,
      greeting: buildGreeting(context.fullName, context.timezone),
      connections: context.connections,
      permissionMode: context.permissionMode,
      automationsPaused: context.automationsPaused,
      conversations: conversations.data ?? [],
      tasks: tasks.data ?? [],
      reminders: {
        upcoming: (reminders.data ?? []).filter((r) => new Date(r.due_at).getTime() >= now),
        overdue: (reminders.data ?? []).filter((r) => new Date(r.due_at).getTime() < now),
        todayCount: (reminders.data ?? []).filter((r) =>
          String(r.due_at).startsWith(todayIso)
        ).length,
      },
      automations: automations.data ?? [],
      recentActions: actions.data ?? [],
      integrationErrors: [
        ...(failures.data ?? []).map((f) => ({
          source: "tool",
          name: f.tool_name,
          status: f.status,
          message: f.validation_error,
          at: f.created_at,
        })),
        ...(integrations.data ?? [])
          .filter((i) => i.status === "error" || i.last_error)
          .map((i) => ({
            source: "integration",
            name: i.provider,
            status: i.status,
            message: i.last_error,
            at: i.last_checked_at ?? i.connected_at,
          })),
      ],
      notifications: notifications.data ?? [],
      pendingActions: pending.data ?? [],
      usage: usageSummary,
      jobs: jobs.data ?? [],
      hasServiceRole: Boolean(context) && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    });
  } catch (error) {
    return jsonError(error);
  }
}

function buildGreeting(name: string | null, timezone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    }).format(new Date())
  );
  const part = hour < 5 ? "Still up" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name.split(" ")[0]}` : part;
}
