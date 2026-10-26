"use client";

import { useCallback, useState } from "react";
import { useAsyncEffect } from "@/hooks/useAsyncEffect";
import { AlarmClock, Bell, Clock, Loader2, Plus, Trash2 } from "lucide-react";
import { del, errorMessage, get, patch, post } from "@/lib/client/api";
import { Badge, EmptyState, PageHeader, Spinner, formatWhen, timeAgo } from "@/components/ui";

interface Reminder {
  id: string;
  title: string;
  note: string | null;
  due_at: string;
  timezone: string;
  rrule: string | null;
  status: string;
  fired_count: number;
  last_fired_at: string | null;
  last_error: string | null;
  created_at: string;
  /** Judged server-side against the sweep's clock, so the UI never invents lateness. */
  is_overdue?: boolean;
}

/**
 * Reminders (section 9). Rows are written to Postgres *and* a scheduled job, so delivery
 * does not depend on this tab being open — see the note under the list.
 */
export default function RemindersPage() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [overdue, setOverdue] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    title: "",
    note: "",
    dueLocal: "",
    recurrence: "none",
    weekday: "1",
    hour: "9",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await get<{ reminders: Reminder[]; overdue: number }>("/api/reminders");
      setReminders(res.reminders);
      setOverdue(res.overdue);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useAsyncEffect(load);

  async function create() {
    if (!form.title.trim()) return setError("A title is required.");

    let dueAt: string | undefined;
    let rrule: string | undefined;

    if (form.recurrence === "none") {
      if (!form.dueLocal) return setError("Pick a date and time.");
      const parsed = new Date(form.dueLocal);
      if (Number.isNaN(parsed.getTime())) return setError("That date could not be parsed.");
      dueAt = parsed.toISOString();
    } else if (form.recurrence === "daily") {
      rrule = `FREQ=DAILY;BYHOUR=${form.hour};BYMINUTE=0`;
    } else if (form.recurrence === "weekly") {
      rrule = `FREQ=WEEKLY;BYDAY=${["SU", "MO", "TU", "WE", "TH", "FR", "SA"][Number(form.weekday)]};BYHOUR=${form.hour};BYMINUTE=0`;
    }

    setBusy(true);
    setError(null);
    try {
      await post("/api/reminders", {
        title: form.title.trim(),
        note: form.note.trim() || undefined,
        dueAt,
        rrule,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setForm({ title: "", note: "", dueLocal: "", recurrence: "none", weekday: "1", hour: "9" });
      setAdding(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function snooze(id: string, minutes: number) {
    try {
      await patch(`/api/reminders/${id}`, { snoozeMinutes: minutes });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(id: string) {
    try {
      await del(`/api/reminders/${id}`);
      setReminders((r) => r.filter((x) => x.id !== id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div>
      <PageHeader
        title="Reminders"
        subtitle="One-time and recurring reminders with timezone-aware scheduling, missed-run recovery and bounded retries."
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => void load()}>
              <AlarmClock size={15} /> Refresh
            </button>
            <button className="btn btn-primary" onClick={() => setAdding((v) => !v)}>
              <Plus size={15} /> New reminder
            </button>
          </>
        }
      />

      <div className="mb-4 rounded-xl border border-arc/30 bg-arc/8 px-4 py-3 text-sm text-mute">
        <div className="flex items-start gap-2">
          <Bell size={15} className="mt-0.5 shrink-0 text-arc" />
          <p>
            <span className="text-ink">Reminders run on the server.</span> Each one is stored in
            Postgres with a queued job, drained by a protected cron sweep with{" "}
            <code className="text-arc">FOR UPDATE SKIP LOCKED</code> claiming — so it fires even if
            this page is closed. While JARVIS <em>is</em> open, a user-scoped heartbeat sweeps every
            minute for tighter timing.
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#ffb9c6]">
          {error}
        </div>
      )}

      {adding && (
        <div className="panel mb-4 p-4">
          <div className="label mb-3">New reminder</div>
          <input
            className="input mb-2"
            placeholder="What should JARVIS remind you about?"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <input
            className="input mb-2"
            placeholder="Optional note"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />

          <div className="mb-3 flex flex-wrap gap-2">
            <select
              className="input w-auto"
              value={form.recurrence}
              onChange={(e) => setForm({ ...form, recurrence: e.target.value })}
            >
              <option value="none">One time</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
            </select>

            {form.recurrence === "none" && (
              <input
                type="datetime-local"
                className="input w-auto"
                value={form.dueLocal}
                onChange={(e) => setForm({ ...form, dueLocal: e.target.value })}
              />
            )}

            {form.recurrence === "weekly" && (
              <select
                className="input w-auto"
                value={form.weekday}
                onChange={(e) => setForm({ ...form, weekday: e.target.value })}
              >
                {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(
                  (d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  )
                )}
              </select>
            )}

            {form.recurrence !== "none" && (
              <select
                className="input w-auto"
                value={form.hour}
                onChange={(e) => setForm({ ...form, hour: e.target.value })}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={create} disabled={busy}>
              {busy && <Loader2 size={14} className="animate-spin" />} Schedule
            </button>
            <button className="btn btn-ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <Spinner label="Loading reminders…" />
      ) : reminders.length === 0 ? (
        <EmptyState
          title="No reminders scheduled"
          hint='Try: “Remind me tomorrow at 9 AM to finish my project”.'
        />
      ) : (
        <div className="space-y-2">
          {overdue > 0 && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#ffb9c6]">
              {overdue} reminder{overdue > 1 ? "s are" : " is"} overdue — the next sweep will deliver
              them.
            </div>
          )}

          {reminders.map((r) => {
            const late = Boolean(r.is_overdue);
            return (
              <article key={r.id} className="panel flex flex-wrap items-start gap-3 p-4">
                <Clock
                  size={16}
                  className={`mt-0.5 shrink-0 ${late ? "text-danger" : r.status === "delivered" ? "text-faint" : "text-arc"}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-white">{r.title}</h3>
                    <Badge
                      tone={
                        r.status === "delivered"
                          ? "ok"
                          : r.status === "cancelled"
                            ? "neutral"
                            : late
                              ? "danger"
                              : "info"
                      }
                    >
                      {late ? "overdue" : r.status}
                    </Badge>
                    {r.rrule && <Badge tone="warn">recurring</Badge>}
                    {r.fired_count > 0 && <Badge tone="neutral">fired {r.fired_count}×</Badge>}
                  </div>
                  {r.note && <p className="mt-1 text-sm text-mute">{r.note}</p>}
                  <div className="mt-2 text-xs text-faint">
                    due {formatWhen(r.due_at, r.timezone)} · {r.timezone}
                    {r.last_fired_at && ` · last fired ${timeAgo(r.last_fired_at)}`}
                  </div>
                  {r.rrule && <div className="mt-1 font-mono text-[11px] text-faint">{r.rrule}</div>}
                  {r.last_error && <div className="mt-1 text-xs text-[#ffb9c6]">{r.last_error}</div>}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {r.status === "pending" && (
                    <button
                      className="btn btn-ghost h-7 px-2 text-xs"
                      onClick={() => snooze(r.id, 60)}
                    >
                      +1h
                    </button>
                  )}
                  {r.status === "delivered" && (
                    <button
                      className="btn btn-ghost h-7 px-2 text-xs"
                      onClick={() => snooze(r.id, 60 * 24)}
                    >
                      Re-arm
                    </button>
                  )}
                  <button
                    className="rounded-md p-1.5 text-faint transition hover:text-danger"
                    onClick={() => remove(r.id)}
                    title="Delete reminder"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
