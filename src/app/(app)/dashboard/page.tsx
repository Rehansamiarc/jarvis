import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Activity,
  ArrowRight,
  Brain,
  CircleAlert,
  Clock,
  ListChecks,
  Plug,
  Timer,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { loadRuntimeContext } from "@/lib/agent/context";
import { Badge, formatWhen, timeAgo } from "@/components/ui";
import SparkOrb from "@/components/SparkOrb";
import { availability } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Dashboard (section 15). Server-rendered straight from Postgres through the caller's
 * RLS-scoped client — no second HTTP hop, and no possibility of seeing another account.
 */
export default async function DashboardPage() {
  if (!availability().supabase) redirect("/");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const uid = user.id;
  const ctx = await loadRuntimeContext(supabase, uid);

  const [
    conversations,
    tasks,
    reminders,
    automations,
    actions,
    failures,
    notifications,
    pending,
    usage,
    jobs,
  ] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, title, last_message_at")
      .eq("user_id", uid)
      .is("archived_at", null)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(5),
    supabase
      .from("tasks")
      .select("id, title, status, priority, created_at")
      .eq("user_id", uid)
      .in("status", ["pending", "running"])
      .order("created_at", { ascending: false })
      .limit(6),
    supabase
      .from("reminders")
      .select("id, title, due_at, timezone, status, rrule")
      .eq("user_id", uid)
      .in("status", ["pending", "snoozed"])
      .order("due_at", { ascending: true })
      .limit(6),
    supabase
      .from("automation_rules")
      .select("id, name, enabled, last_run_at, last_error, run_count")
      .eq("user_id", uid)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("action_logs")
      .select("id, action_name, target, status, risk, error, duration_ms, created_at")
      .eq("user_id", uid)
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("execution_logs")
      .select("id, tool_name, status, validation_error, created_at")
      .eq("user_id", uid)
      .in("status", ["error", "rejected", "timeout"])
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("notifications")
      .select("id, level, title, created_at, read_at")
      .eq("user_id", uid)
      .order("created_at", { ascending: false })
      .limit(6),
    supabase
      .from("pending_actions")
      .select("id, title, action_name, risk, created_at")
      .eq("user_id", uid)
      .eq("status", "proposed"),
    supabase
      .from("usage_logs")
      .select("input_tokens, output_tokens, cost_usd")
      .eq("user_id", uid)
      // Server component: reading the clock once per request is exactly the intent here.
      // eslint-disable-next-line react-hooks/purity
      .gte("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString())
      .limit(500),
    supabase
      .from("scheduled_jobs")
      .select("id, kind, status, run_at, attempts, last_error")
      .eq("user_id", uid)
      .in("status", ["scheduled", "failed", "dead"])
      .order("run_at", { ascending: true })
      .limit(6),
  ]);

  // Server component, rendered per request — the clock read is the request's own clock.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const upcoming = (reminders.data ?? []).filter((r) => new Date(r.due_at).getTime() >= now);
  const overdue = (reminders.data ?? []).filter((r) => new Date(r.due_at).getTime() < now);

  const usageTotals = (usage.data ?? []).reduce(
    (acc, row) => {
      acc.tokens += (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
      acc.cost += Number(row.cost_usd ?? 0);
      acc.calls += 1;
      return acc;
    },
    { tokens: 0, cost: 0, calls: 0 }
  );

  const connected = Object.entries(ctx.connections).filter(([, s]) => s === "connected");
  const notConnected = ["wordpress", "youtube", "gmail"].filter((p) => ctx.connections[p] !== "connected");

  return (
    <div className="space-y-6">
      {/* The spark is the interface: everything below it is the readout. */}
      <header className="relative -mx-4 -mt-5 flex flex-col items-center px-4 pt-2 sm:-mx-6 sm:px-6">
        <div className="relative h-[clamp(260px,44vh,420px)] w-full max-w-[560px]">
          <SparkOrb state={pending.data?.length ? "thinking" : "idle"} />
        </div>

        <div className="relative z-10 -mt-4 text-center">
          <p className="text-[0.6rem] uppercase tracking-[0.44em] text-faint">
            {ctx.automationsPaused ? "automations paused" : "jarvis online"}
          </p>
          <h1 className="mt-2.5 text-xl font-light tracking-tight text-white sm:text-2xl">
            {greeting(ctx.fullName)}
          </h1>
          <p className="mt-1 text-[11px] tracking-wide text-mute">
            {formatWhen(new Date().toISOString(), ctx.timezone)} · {ctx.timezone}
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Link href="/chat" className="btn btn-primary h-9 text-[13px]">
            Talk to JARVIS
          </Link>
          <Link href="/chat?voice=1" className="btn btn-ghost h-9 text-[13px]">
            Voice mode
          </Link>
          <span className="mx-1 h-4 w-px bg-white/10" />
          <Badge tone={ctx.automationsPaused ? "warn" : "info"}>
            {ctx.permissionMode.replace(/_/g, " ")}
          </Badge>
          <Badge tone={connected.length ? "ok" : "neutral"}>
            {connected.length} link{connected.length === 1 ? "" : "s"}
          </Badge>
          <Badge tone="neutral">{usageTotals.calls} calls · ${usageTotals.cost.toFixed(2)}</Badge>
        </div>
      </header>

      {(pending.data?.length ?? 0) > 0 && (
        <Link
          href="/activity?view=approvals"
          className="panel-glow flex items-center gap-3 border-gold/50 bg-gold/10 px-4 py-3"
        >
          <CircleAlert size={17} className="text-gold" />
          <span className="text-sm text-white">
            {pending.data!.length} action{pending.data!.length > 1 ? "s" : ""} waiting for your approval
          </span>
          <ArrowRight size={15} className="ml-auto text-gold" />
        </Link>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Panel title="Today's tasks" icon={<ListChecks size={15} />} href="/tasks" count={tasks.data?.length ?? 0}>
          {(tasks.data ?? []).length === 0 ? (
            <p className="text-sm text-faint">Nothing queued. Ask JARVIS to create one.</p>
          ) : (
            <ul className="space-y-2">
              {tasks.data!.map((t) => (
                <li key={t.id} className="flex items-start gap-2 text-sm">
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      t.status === "running" ? "bg-arc" : "bg-faint"
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate text-ink">{t.title}</span>
                  <Badge tone={t.status === "running" ? "info" : "neutral"}>{t.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Upcoming reminders"
          icon={<Timer size={15} />}
          href="/reminders"
          count={upcoming.length + overdue.length}
        >
          {upcoming.length + overdue.length === 0 ? (
            <p className="text-sm text-faint">No pending reminders.</p>
          ) : (
            <ul className="space-y-2">
              {overdue.slice(0, 2).map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate text-ink">{r.title}</span>
                  <Badge tone="danger">overdue</Badge>
                </li>
              ))}
              {upcoming.slice(0, 4).map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate text-ink">{r.title}</span>
                  <span className="shrink-0 text-xs text-faint">
                    {formatWhen(r.due_at, r.timezone).replace(/^\w+, /, "")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Active automations"
          icon={<Clock size={15} />}
          href="/settings"
          count={automations.data?.length ?? 0}
        >
          {(automations.data ?? []).length === 0 ? (
            <p className="text-sm text-faint">
              No automations yet. Create one from Settings → Automations.
            </p>
          ) : (
            <ul className="space-y-2">
              {automations.data!.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate text-ink">{a.name}</span>
                  <Badge tone={a.enabled ? "ok" : "neutral"}>{a.enabled ? "on" : "off"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Recent conversations" icon={<Brain size={15} />} href="/chat">
          {(conversations.data ?? []).length === 0 ? (
            <p className="text-sm text-faint">No conversations yet.</p>
          ) : (
            <ul className="space-y-2">
              {conversations.data!.map((c) => (
                <li key={c.id}>
                  <Link href={`/chat?c=${c.id}`} className="flex items-center justify-between gap-2 text-sm hover:text-arc">
                    <span className="min-w-0 truncate text-ink">{c.title}</span>
                    <span className="shrink-0 text-xs text-faint">{timeAgo(c.last_message_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Recent actions"
          icon={<Activity size={15} />}
          href="/activity"
          count={actions.data?.length ?? 0}
        >
          {(actions.data ?? []).length === 0 ? (
            <p className="text-sm text-faint">No actions recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {actions.data!.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate font-mono text-xs text-ink">{a.action_name}</span>
                  <Badge
                    tone={
                      a.status === "succeeded" ? "ok" : a.status === "denied" ? "warn" : "danger"
                    }
                  >
                    {a.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Connected accounts"
          icon={<Plug size={15} />}
          href="/connections"
          count={connected.length}
        >
          <div className="space-y-1.5 text-sm">
            {connected.map(([p]) => (
              <div key={p} className="flex items-center justify-between">
                <span className="capitalize text-ink">{p}</span>
                <Badge tone="ok">connected</Badge>
              </div>
            ))}
            {notConnected.map((p) => (
              <div key={p} className="flex items-center justify-between">
                <span className="capitalize text-mute">{p}</span>
                <Badge tone="neutral">not connected</Badge>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Integration & tool errors" icon={<CircleAlert size={15} />}>
          {(failures.data ?? []).length === 0 ? (
            <p className="text-sm text-faint">No failures in the recent log.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {failures.data!.map((f) => (
                <li key={f.id} className="flex items-start gap-2">
                  <Badge tone="danger">{f.status}</Badge>
                  <div className="min-w-0">
                    <span className="font-mono text-xs text-ink">{f.tool_name}</span>
                    {f.validation_error && (
                      <p className="mt-0.5 break-words text-xs text-faint">{f.validation_error}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Scheduler" icon={<Timer size={15} />} href="/reminders">
          <p className="mb-2 text-sm text-mute">
            Reminders live in Postgres and are drained by cron — the browser does not need to stay
            open.
          </p>
          {(jobs.data ?? []).length === 0 ? (
            <p className="text-sm text-faint">No queued or failed jobs.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {jobs.data!.map((j) => (
                <li key={j.id} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-ink">{j.kind}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-faint">{formatWhen(j.run_at, ctx.timezone)}</span>
                    <Badge
                      tone={j.status === "dead" ? "danger" : j.status === "failed" ? "warn" : "neutral"}
                    >
                      {j.status}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {(notifications.data ?? []).filter((n) => !n.read_at).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {(notifications.data ?? [])
            .filter((n) => !n.read_at)
            .map((n) => (
              <Badge key={n.id} tone={n.level === "error" ? "danger" : "info"}>
                {n.title}
              </Badge>
            ))}
        </div>
      )}
    </div>
  );
}

function greeting(name: string | null): string {
  const hour = new Date().getHours();
  const part = hour < 5 ? "Still up" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name.split(" ")[0]}` : `${part}. JARVIS at your service.`;
}

function Panel({
  title,
  icon,
  href,
  count,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  href?: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="panel p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-arc">{icon}</span>
        <h2 className="label flex-1">{title}</h2>
        {typeof count === "number" && count > 0 && <Badge tone="neutral">{count}</Badge>}
        {href && (
          <Link href={href} className="text-faint transition hover:text-arc" aria-label={`Open ${title}`}>
            <ArrowRight size={14} />
          </Link>
        )}
      </div>
      <div className="min-h-[3rem]">{children}</div>
    </section>
  );
}
