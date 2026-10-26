"use client";

import { useCallback, useEffect, useState, Suspense } from "react";
import { useAsyncEffect } from "@/hooks/useAsyncEffect";
import { useSearchParams } from "next/navigation";
import { Activity as ActivityIcon, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { errorMessage, get } from "@/lib/client/api";
import { Badge, EmptyState, PageHeader, Spinner, timeAgo } from "@/components/ui";

interface TimelineEntry {
  stream: "action" | "tool";
  at: string;
  id: string;
  name: string;
  status: string;
  risk: string | null;
  target: string | null;
  detail: string | null;
  durationMs: number | null;
}

interface Approval {
  id: string;
  action_name: string;
  risk: string;
  title: string;
  preview: Record<string, unknown>;
  status: string;
  error: string | null;
  expires_at: string;
  decided_at: string | null;
  created_at: string;
}

interface JobRow {
  id: string;
  kind: string;
  status: string;
  run_at: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  completed_at: string | null;
}

interface UsageRow {
  id: string;
  model: string;
  operation: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number | null;
  created_at: string;
}

interface ActivityData {
  timeline: TimelineEntry[];
  approvals: Approval[];
  jobs: JobRow[];
  usage: UsageRow[];
}

const VIEWS = [
  { key: "all", label: "Timeline" },
  { key: "approvals", label: "Approvals" },
  { key: "actions", label: "Actions" },
  { key: "executions", label: "Tool calls" },
  { key: "jobs", label: "Scheduler" },
  { key: "usage", label: "Usage" },
] as const;

function ActivityInner() {
  const params = useSearchParams();
  const [view, setView] = useState<string>(params.get("view") ?? "all");
  const [data, setData] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await get<ActivityData>(`/api/activity?view=${view}&limit=80`);
      setData(res);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [view]);

  useAsyncEffect(load);

  // Poll while the panel is open; the interval callback is not an effect-body setState.
  useEffect(() => {
    const id = setInterval(load, 25_000);
    return () => clearInterval(id);
  }, [load]);

  const usageTotals = (data?.usage ?? []).reduce(
    (acc, u) => {
      acc.tokens += u.input_tokens + u.output_tokens;
      acc.cost += Number(u.cost_usd);
      acc.calls += 1;
      return acc;
    },
    { tokens: 0, cost: 0, calls: 0 }
  );

  return (
    <div>
      <PageHeader
        title="Activity"
        subtitle="The audit trail: what was proposed, what the server permitted, what actually executed, and what the provider returned. Nothing here is written from the model's own claims."
        actions={
          <button className="btn btn-ghost" onClick={() => void load()}>
            <Loader2 size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={`rounded-full border px-3 py-1 text-xs transition ${
              view === v.key
                ? "border-arc/50 bg-arc/12 text-arc"
                : "border-line2 text-mute hover:border-arc-dim hover:text-ink"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#ffb9c6]">
          {error}
        </div>
      )}

      {loading && !data ? (
        <Spinner label="Loading activity…" />
      ) : view === "all" ? (
        (data?.timeline.length ?? 0) === 0 ? (
          <EmptyState title="No activity yet" hint="Actions and tool calls will appear here as JARVIS works." />
        ) : (
          <ol className="relative space-y-2 border-l border-line pl-5">
            {data!.timeline.map((entry) => (
              <li key={`${entry.stream}-${entry.id}`} className="relative">
                <span
                  className={`absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-void ${
                    entry.status === "ok" || entry.status === "succeeded"
                      ? "bg-ok"
                      : entry.status === "awaiting_approval"
                        ? "bg-gold"
                        : entry.status === "denied" || entry.status === "rejected"
                          ? "bg-faint"
                          : "bg-danger"
                  }`}
                />
                <div className="panel flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="font-mono text-xs text-arc">{entry.name}</span>
                  <Badge
                    tone={
                      entry.status === "ok" || entry.status === "succeeded"
                        ? "ok"
                        : entry.status === "awaiting_approval"
                          ? "warn"
                          : entry.status === "denied" || entry.status === "rejected"
                            ? "neutral"
                            : "danger"
                    }
                  >
                    {entry.status}
                  </Badge>
                  {entry.risk && <Badge tone="neutral">{entry.risk}</Badge>}
                  {entry.target && <span className="truncate text-xs text-mute">{entry.target}</span>}
                  {entry.durationMs != null && (
                    <span className="ml-auto flex items-center gap-1 text-[11px] text-faint">
                      <Clock size={10} /> {entry.durationMs}ms
                    </span>
                  )}
                  <span className="text-[11px] text-faint">{timeAgo(entry.at)}</span>
                </div>
                {entry.detail && (
                  <p className="mt-1 break-words pl-1 text-xs text-faint">{entry.detail}</p>
                )}
              </li>
            ))}
          </ol>
        )
      ) : view === "approvals" ? (
        (data?.approvals.length ?? 0) === 0 ? (
          <EmptyState title="No approval requests" hint="Consequential actions will appear here before they run." />
        ) : (
          <div className="space-y-3">
            {data!.approvals.map((a) => (
              <article key={a.id} className="panel p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-white">{a.title}</h3>
                  <Badge tone={a.risk === "high" ? "danger" : "warn"}>{a.risk}</Badge>
                  <Badge
                    tone={
                      a.status === "executed"
                        ? "ok"
                        : a.status === "denied" || a.status === "expired"
                          ? "neutral"
                          : a.status === "failed"
                            ? "danger"
                            : "warn"
                    }
                  >
                    {a.status}
                  </Badge>
                  <span className="ml-auto text-[11px] text-faint">{timeAgo(a.created_at)}</span>
                </div>
                <div className="rounded-lg border border-line bg-void/50 p-3">
                  <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
                    {Object.entries(a.preview)
                      .filter(([k]) => k !== "action")
                      .map(([k, v]) => (
                        <div key={k} className="contents">
                          <dt className="text-faint">{k}</dt>
                          <dd className="min-w-0 break-words text-ink">
                            {typeof v === "string" && v.length > 500 ? `${v.slice(0, 500)}…` : typeof v === "string" ? v : JSON.stringify(v)}
                          </dd>
                        </div>
                      ))}
                  </dl>
                </div>
                {a.error && <p className="mt-2 text-xs text-[#ffb9c6]">{a.error}</p>}
                <div className="mt-2 flex items-center gap-3 text-[11px] text-faint">
                  {a.status === "executed" && (
                    <span className="flex items-center gap-1 text-ok">
                      <CheckCircle2 size={11} /> executed {a.decided_at ? timeAgo(a.decided_at) : ""}
                    </span>
                  )}
                  {(a.status === "denied" || a.status === "expired") && (
                    <span className="flex items-center gap-1">
                      <XCircle size={11} /> {a.status}
                    </span>
                  )}
                  <span>expires {timeAgo(a.expires_at)}</span>
                </div>
              </article>
            ))}
          </div>
        )
      ) : view === "jobs" ? (
        (data?.jobs.length ?? 0) === 0 ? (
          <EmptyState title="No scheduled jobs" hint="Reminders and automations appear here while queued." />
        ) : (
          <div className="space-y-2">
            {data!.jobs.map((j) => (
              <div key={j.id} className="panel flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <ActivityIcon size={14} className="text-arc" />
                <span className="font-mono text-xs text-ink">{j.kind}</span>
                <Badge
                  tone={j.status === "dead" ? "danger" : j.status === "failed" ? "warn" : j.status === "succeeded" ? "ok" : "neutral"}
                >
                  {j.status}
                </Badge>
                <span className="text-xs text-faint">
                  attempt {j.attempts}/{j.max_attempts}
                </span>
                <span className="ml-auto text-xs text-faint">{timeAgo(j.completed_at ?? j.run_at)}</span>
                {j.last_error && <span className="w-full break-words text-xs text-[#ffb9c6]">{j.last_error}</span>}
              </div>
            ))}
          </div>
        )
      ) : view === "usage" ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="panel px-4 py-3">
              <div className="label">Calls (30d window)</div>
              <div className="mt-1 text-2xl font-semibold text-white">{usageTotals.calls}</div>
            </div>
            <div className="panel px-4 py-3">
              <div className="label">Tokens</div>
              <div className="mt-1 text-2xl font-semibold text-white">{usageTotals.tokens.toLocaleString()}</div>
            </div>
            <div className="panel px-4 py-3">
              <div className="label">Est. cost</div>
              <div className="mt-1 text-2xl font-semibold text-arc">${usageTotals.cost.toFixed(4)}</div>
            </div>
          </div>
          {(data?.usage.length ?? 0) === 0 ? (
            <EmptyState title="No usage recorded" hint="Model calls are logged here with token counts and estimated cost." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="label">
                  <tr>
                    <th className="py-2">Time</th>
                    <th>Model</th>
                    <th>Op</th>
                    <th className="text-right">In</th>
                    <th className="text-right">Out</th>
                    <th className="text-right">Cost</th>
                    <th className="text-right">Latency</th>
                  </tr>
                </thead>
                <tbody className="text-mute">
                  {(data?.usage ?? []).slice(0, 60).map((u) => (
                    <tr key={u.id} className="border-t border-line/60">
                      <td className="py-1.5">{timeAgo(u.created_at)}</td>
                      <td className="font-mono text-ink">{u.model}</td>
                      <td>{u.operation}</td>
                      <td className="text-right tabular-nums">{u.input_tokens}</td>
                      <td className="text-right tabular-nums">{u.output_tokens}</td>
                      <td className="text-right tabular-nums">${Number(u.cost_usd).toFixed(4)}</td>
                      <td className="text-right tabular-nums">{u.latency_ms ?? "—"}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {((view === "actions" ? data?.timeline : data?.timeline) ?? []).length === 0 && (
            <EmptyState title="Nothing recorded yet" hint="Run something and it will show up here." />
          )}
          {(data?.timeline ?? [])
            .filter((e) => (view === "actions" ? e.stream === "action" : e.stream === "tool"))
            .map((e) => (
              <div key={`v-${e.id}`} className="panel flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="font-mono text-xs text-arc">{e.name}</span>
                <Badge
                  tone={
                    e.status === "ok" || e.status === "succeeded"
                      ? "ok"
                      : e.status === "denied" || e.status === "rejected"
                        ? "neutral"
                        : "danger"
                  }
                >
                  {e.status}
                </Badge>
                {e.target && <span className="truncate text-xs text-mute">{e.target}</span>}
                <span className="ml-auto text-[11px] text-faint">{timeAgo(e.at)}</span>
                {e.detail && <span className="w-full break-words text-xs text-faint">{e.detail}</span>}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export default function ActivityPage() {
  return (
    <Suspense fallback={<div className="p-6"><Spinner label="Loading activity…" /></div>}>
      <ActivityInner />
    </Suspense>
  );
}
