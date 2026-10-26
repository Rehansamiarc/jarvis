"use client";

import { useCallback, useState } from "react";
import { useAsyncEffect } from "@/hooks/useAsyncEffect";
import { CheckCircle2, Loader2, Plus, Trash2, XCircle } from "lucide-react";
import { del, errorMessage, get, patch, post } from "@/lib/client/api";
import { Badge, EmptyState, PageHeader, Spinner, timeAgo } from "@/components/ui";

interface Task {
  id: string;
  title: string;
  instruction: string;
  status: string;
  priority: number;
  result_summary: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

const FILTERS = ["", "pending", "running", "completed", "failed", "cancelled"] as const;

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: "", instruction: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await get<{ tasks: Task[] }>(`/api/tasks${filter ? `?status=${filter}` : ""}`);
      setTasks(res.tasks);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useAsyncEffect(load);

  async function create() {
    if (!form.title.trim() || !form.instruction.trim()) {
      setError("Both a title and an instruction are required.");
      return;
    }
    setBusy(true);
    try {
      await post("/api/tasks", form);
      setForm({ title: "", instruction: "" });
      setAdding(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: string) {
    try {
      await patch(`/api/tasks/${id}`, { status });
      setTasks((t) => t.map((x) => (x.id === id ? { ...x, status } : x)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(id: string) {
    try {
      await del(`/api/tasks/${id}`);
      setTasks((t) => t.filter((x) => x.id !== id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const tone = (status: string) =>
    status === "completed" ? "ok" : status === "failed" ? "danger" : status === "running" ? "info" : "neutral";

  return (
    <div>
      <PageHeader
        title="Tasks"
        subtitle="Multi-step work JARVIS is tracking. Status here comes from recorded execution results, not from the model claiming success."
        actions={
          <button className="btn btn-primary" onClick={() => setAdding((v) => !v)}>
            <Plus size={15} /> New task
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f || "all"}
            onClick={() => setFilter(f)}
            className={`rounded-full border px-3 py-1 text-xs transition ${
              filter === f
                ? "border-arc/50 bg-arc/12 text-arc"
                : "border-line2 text-mute hover:border-arc-dim hover:text-ink"
            }`}
          >
            {f || "all"}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#ffb9c6]">
          {error}
        </div>
      )}

      {adding && (
        <div className="panel mb-4 p-4">
          <div className="label mb-3">New task</div>
          <input
            className="input mb-2"
            placeholder="Title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <textarea
            className="input mb-3"
            rows={3}
            placeholder="What should be accomplished?"
            value={form.instruction}
            onChange={(e) => setForm({ ...form, instruction: e.target.value })}
          />
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={create} disabled={busy}>
              {busy && <Loader2 size={14} className="animate-spin" />} Create
            </button>
            <button className="btn btn-ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <Spinner label="Loading tasks…" />
      ) : tasks.length === 0 ? (
        <EmptyState
          title={filter ? `No ${filter} tasks` : "No tasks yet"}
          hint="Ask JARVIS to track something, or add one here."
          action={
            <button className="btn btn-ghost" onClick={() => setAdding(true)}>
              Create a task
            </button>
          }
        />
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => (
            <article key={t.id} className="panel flex flex-wrap items-start gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-white">{t.title}</h3>
                  <Badge tone={tone(t.status)}>{t.status}</Badge>
                  <Badge tone="neutral">P{t.priority}</Badge>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-mute">{t.instruction}</p>
                {t.result_summary && (
                  <p className="mt-2 rounded-lg border border-line bg-void/40 px-3 py-2 text-xs text-ink">
                    {t.result_summary}
                  </p>
                )}
                {t.error && <p className="mt-2 text-xs text-[#ffb9c6]">{t.error}</p>}
                <div className="mt-2 text-[11px] text-faint">
                  created {timeAgo(t.created_at)}
                  {t.finished_at && ` · finished ${timeAgo(t.finished_at)}`}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {t.status !== "completed" && (
                  <button
                    className="rounded-md p-1.5 text-faint transition hover:text-ok"
                    onClick={() => setStatus(t.id, "completed")}
                    title="Mark completed"
                  >
                    <CheckCircle2 size={15} />
                  </button>
                )}
                {t.status !== "cancelled" && (
                  <button
                    className="rounded-md p-1.5 text-faint transition hover:text-gold"
                    onClick={() => setStatus(t.id, "cancelled")}
                    title="Cancel task"
                  >
                    <XCircle size={15} />
                  </button>
                )}
                <button
                  className="rounded-md p-1.5 text-faint transition hover:text-danger"
                  onClick={() => remove(t.id)}
                  title="Delete task"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
