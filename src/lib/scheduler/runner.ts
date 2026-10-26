import "server-only";
import { randomToken } from "@/lib/crypto/secrets";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobKind } from "./queue";
import { jobKey } from "./queue";
import { notify } from "@/lib/notify";
import { sendNotificationEmail } from "@/lib/integrations/resend";
import { env } from "@/lib/env";
import { RRule } from "rrule";
import { DateTime } from "luxon";

/**
 * Job worker (section 9).
 *
 * `sweep()` claims a bounded batch, runs each job to completion, and records the real
 * outcome. Failures are retried with bounded attempts and then parked in `dead` for
 * inspection — never silently dropped, never infinitely retried.
 */

export interface SweepOptions {
  limit?: number;
  leaseMs?: number;
  kinds?: JobKind[];
  userId?: string;
}

export interface SweepResult {
  claimed: number;
  succeeded: number;
  failed: number;
  dead: number;
  rescheduled: number;
  errors: string[];
}

interface JobRow {
  id: string;
  user_id: string;
  kind: JobKind;
  status: string;
  run_at: string;
  attempts: number;
  max_attempts: number;
  claim_token: string | null;
  payload: Record<string, unknown>;
}

export async function sweep(db: SupabaseClient, options: SweepOptions = {}): Promise<SweepResult> {
  const token = randomToken(24);
  const result: SweepResult = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
    rescheduled: 0,
    errors: [],
  };

  const { data, error } = await db.rpc("claim_scheduled_jobs", {
    p_token: token,
    p_limit: options.limit ?? 20,
    p_lease_ms: options.leaseMs ?? 300_000,
    p_kinds: options.kinds ?? null,
  });

  if (error) {
    result.errors.push(`claim failed: ${error.message}`);
    return result;
  }

  const jobs = (data ?? []) as JobRow[];
  result.claimed = jobs.length;
  if (!jobs.length) return result;

  for (const job of jobs) {
    try {
      await db.rpc("mark_job_running", { p_id: job.id, p_token: token });

      const outcome = await executeJob(db, job);

      if (outcome.rescheduleAt) {
        await db.rpc("reschedule_job", {
          p_id: job.id,
          p_token: token,
          p_run_at: outcome.rescheduleAt.toISOString(),
          p_reason: outcome.note ?? null,
        });
        result.rescheduled++;
        continue;
      }

      if (outcome.ok) {
        await db.rpc("complete_job", {
          p_id: job.id,
          p_token: token,
          p_status: "succeeded",
          p_result: outcome.result ?? null,
          p_error: null,
        });
        result.succeeded++;
      } else {
        const exhausted = job.attempts >= job.max_attempts;
        await db.rpc("complete_job", {
          p_id: job.id,
          p_token: token,
          p_status: exhausted ? "dead" : "failed",
          p_result: outcome.result ?? null,
          p_error: outcome.error ?? "unknown error",
        });
        if (exhausted) {
          result.dead++;
          await notify(db, job.user_id, {
            kind: "system",
            level: "error",
            title: "A background job permanently failed",
            body: `${job.kind}: ${outcome.error ?? "unknown error"}`,
            link: "/activity",
            metadata: { jobId: job.id },
          });
        } else {
          result.failed++;
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      result.errors.push(`${job.kind}/${job.id}: ${message}`);
      const exhausted = job.attempts >= job.max_attempts;
      try {
        await db.rpc("complete_job", {
          p_id: job.id,
          p_token: token,
          p_status: exhausted ? "dead" : "failed",
          p_result: null,
          p_error: message,
        });
      } catch {
        /* lease expiry will reclaim it */
      }
      if (exhausted) result.dead++;
      else result.failed++;
    }
  }

  return result;
}

interface JobOutcome {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  note?: string;
  rescheduleAt?: Date;
}

async function executeJob(db: SupabaseClient, job: JobRow): Promise<JobOutcome> {
  switch (job.kind) {
    case "reminder_due":
      return runReminder(db, job);
    case "digest":
      return runDigest(db, job);
    case "maintenance":
      return runMaintenance(db);
    case "task_run":
    case "automation":
      return runAutomation(db, job);
    case "reindex":
      return { ok: true, note: "reindex handled inline by the knowledge route" };
    case "webhook":
      return { ok: false, error: "Webhook jobs are not implemented yet." };
    default:
      return { ok: false, error: `Unknown job kind "${job.kind}"` };
  }
}

// ------------------------------------------------------------------------ reminders

async function runReminder(db: SupabaseClient, job: JobRow): Promise<JobOutcome> {
  const reminderId = String(job.payload.reminderId ?? "");
  if (!reminderId) return { ok: false, error: "Job payload is missing reminderId" };

  const { data: reminder, error } = await db
    .from("reminders")
    .select("id, user_id, title, note, due_at, timezone, rrule, status, attempts, max_attempts, fired_count, recurrence_end_at")
    .eq("id", reminderId)
    .maybeSingle();

  if (error) return { ok: false, error: `Could not load reminder: ${error.message}` };
  if (!reminder) return { ok: true, result: { skipped: "reminder deleted" } };

  if (reminder.status === "cancelled") {
    return { ok: true, result: { skipped: "reminder cancelled" } };
  }
  if (reminder.status === "delivered") {
    return { ok: true, result: { skipped: "already delivered" } };
  }

  const dueAt = new Date(reminder.due_at as string);
  const now = Date.now();

  // Guard against a sweep firing early (clock skew, manual enqueue).
  if (dueAt.getTime() > now + 60_000) {
    return {
      ok: true,
      note: "not yet due",
      rescheduleAt: dueAt,
    };
  }

  const latenessMinutes = Math.round((now - dueAt.getTime()) / 60_000);

  const notificationId = await notify(db, reminder.user_id as string, {
    kind: "reminder",
    level: "info",
    title: (reminder.title as string) || "Reminder",
    body: [
      reminder.note ? String(reminder.note) : "",
      latenessMinutes > 5 ? `(fired ${latenessMinutes} min after its scheduled time)` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    link: "/reminders",
    metadata: { reminderId: reminder.id },
  });

  // Optional email channel — failure never fails the reminder, it is already in-app.
  let emailDelivered: boolean | undefined;
  const { data: prefs } = await db
    .from("user_preferences")
    .select("notify_email")
    .eq("user_id", reminder.user_id as string)
    .maybeSingle();

  if (prefs?.notify_email) {
    const { data: profile } = await db
      .from("profiles")
      .select("email")
      .eq("id", reminder.user_id as string)
      .maybeSingle();
    if (profile?.email) {
      const res = await sendNotificationEmail(
        profile.email,
        `Reminder: ${reminder.title}`,
        `${reminder.title}\n\n${reminder.note ?? ""}\n\nScheduled for ${dueAt.toISOString()}`
      );
      emailDelivered = res.ok;
    }
  }

  const recurring = Boolean(reminder.rrule);
  const firedAt = new Date().toISOString();

  if (recurring) {
    const next = nextOccurrence(String(reminder.rrule), dueAt, reminder.timezone as string);
    if (next && (!reminder.recurrence_end_at || next.getTime() <= new Date(reminder.recurrence_end_at as string).getTime())) {
      await db
        .from("reminders")
        .update({
          due_at: next.toISOString(),
          status: "pending",
          last_fired_at: firedAt,
          fired_count: ((reminder.fired_count as number) ?? 0) + 1,
          attempts: 0,
        })
        .eq("id", reminder.id);

      const { enqueueJob } = await import("./queue");
      await enqueueJob(db, {
        userId: reminder.user_id as string,
        kind: "reminder_due",
        runAt: next,
        payload: { reminderId: reminder.id },
        idempotencyKey: jobKey(reminder.id as string, next.toISOString()),
        priority: 3,
      });

      return {
        ok: true,
        result: { reminderId: reminder.id, delivered: true, nextDue: next.toISOString(), emailDelivered },
      };
    }

    await db
      .from("reminders")
      .update({
        status: "delivered",
        last_fired_at: firedAt,
        fired_count: ((reminder.fired_count as number) ?? 0) + 1,
      })
      .eq("id", reminder.id);
    return { ok: true, result: { reminderId: reminder.id, delivered: true, recurrenceComplete: true } };
  }

  await db
    .from("reminders")
    .update({ status: "delivered", last_fired_at: firedAt, fired_count: 1, attempts: 0 })
    .eq("id", reminder.id);

  return { ok: true, result: { reminderId: reminder.id, delivered: true, notificationId, emailDelivered } };
}

/**
 * Next occurrence of a recurring reminder, anchored in the user's timezone so "9am"
 * stays 9am across DST changes. Falls back to interval-style progression when the RRULE
 * string cannot be parsed rather than dropping the reminder.
 */
function nextOccurrence(rrule: string, previous: Date, timezone: string): Date | null {
  try {
    const rule = RRule.fromString(rrule.includes("DTSTART") ? rrule : `DTSTART:${fmt(previous)}\n${rrule}`);
    const next = rule.after(new Date(previous.getTime() + 60_000), true);
    if (next) return next;
  } catch {
    /* fall through to the manual path */
  }

  try {
    const base = DateTime.fromJSDate(previous).setZone(timezone);
    if (!base.isValid) return null;
    const m = rrule.match(/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/i);
    const interval = (rrule.match(/INTERVAL=(\d+)/i) ?? [])[1];
    const n = interval ? Math.max(1, parseInt(interval, 10)) : 1;
    if (!m) return null;
    const unit = m[1].toUpperCase();
    const next =
      unit === "DAILY" ? base.plus({ days: n }) :
      unit === "WEEKLY" ? base.plus({ weeks: n }) :
      unit === "MONTHLY" ? base.plus({ months: n }) :
      base.plus({ years: n });
    return next.toJSDate();
  } catch {
    return null;
  }
}

function fmt(date: Date): string {
  return DateTime.fromJSDate(date).toUTC().toFormat("yyyyMMdd'T'HHmmss");
}

// ------------------------------------------------------------------------- digest

async function runDigest(db: SupabaseClient, job: JobRow): Promise<JobOutcome> {
  const userId = job.user_id;

  const startOfDay = DateTime.now().setZone("utc").startOf("day").toISO();
  const { data: reminders } = await db
    .from("reminders")
    .select("id, title, due_at, timezone, note")
    .eq("user_id", userId)
    .in("status", ["pending", "snoozed"])
    .order("due_at", { ascending: true })
    .limit(10);

  const { data: tasks } = await db
    .from("tasks")
    .select("id, title, status, priority, created_at")
    .eq("user_id", userId)
    .in("status", ["pending", "running"])
    .order("created_at", { ascending: false })
    .limit(10);

  const { count: overdueCount } = await db
    .from("reminders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "pending")
    .lt("due_at", startOfDay!);

  const lines = [
    `You have ${overdueCount ?? 0} overdue reminder(s).`,
    reminders?.length
      ? `Next reminders:\n${reminders
          .map((r) => `- ${r.title} @ ${new Date(r.due_at).toLocaleString("en-US", { timeZone: r.timezone, dateStyle: "medium", timeStyle: "short" })}`)
          .join("\n")}`
      : "No upcoming reminders.",
    tasks?.length
      ? `Open tasks:\n${tasks.map((t) => `- [${t.status}] ${t.title}`).join("\n")}`
      : "No open tasks.",
  ];

  const notificationId = await notify(db, userId, {
    kind: "digest",
    level: "info",
    title: "Your daily briefing",
    body: lines.join("\n\n"),
    link: "/dashboard",
    metadata: { reminders: reminders?.length ?? 0, tasks: tasks?.length ?? 0 },
  });

  return { ok: true, result: { notificationId, reminderCount: reminders?.length ?? 0, taskCount: tasks?.length ?? 0 } };
}

// --------------------------------------------------------------------- maintenance

async function runMaintenance(db: SupabaseClient): Promise<JobOutcome> {
  const { data: purged, error: purgeError } = await db.rpc("purge_expired");
  try {
    await db.rpc("release_stale_leases");
  } catch {
    /* non-fatal */
  }
  if (purgeError) return { ok: false, error: `purge_expired failed: ${purgeError.message}` };
  return { ok: true, result: { purged } };
}

// --------------------------------------------------------------------- automations

async function runAutomation(db: SupabaseClient, job: JobRow): Promise<JobOutcome> {
  const ruleId = String(job.payload.ruleId ?? "");
  if (!ruleId) return { ok: false, error: "Automation job is missing ruleId" };

  const { data: rule } = await db
    .from("automation_rules")
    .select("id, user_id, name, instruction, enabled")
    .eq("id", ruleId)
    .maybeSingle();

  if (!rule?.enabled) return { ok: true, result: { skipped: "automation disabled" } };

  // The actual work runs through the same agent path as a typed instruction, so an
  // automation can never do something a user could not type themselves.
  const { runAgent } = await import("@/lib/agent/run");
  const { loadRuntimeContext } = await import("@/lib/agent/context");

  const context = await loadRuntimeContext(db, rule.user_id as string);
  const conversation = await db
    .from("conversations")
    .insert({
      user_id: rule.user_id as string,
      title: `Automation: ${rule.name}`,
    })
    .select("id")
    .single();
  if (conversation.error) return { ok: false, error: conversation.error.message };

  const outcome = await runAgent({
    db,
    admin: null,
    userId: rule.user_id as string,
    conversationId: conversation.data.id as string,
    userMessage: String(rule.instruction),
    history: [],
    permissionMode: context.permissionMode,
    personality: context.personality,
    language: context.language,
    timezone: context.timezone,
    connections: context.connections,
  });

  await db
    .from("automation_rules")
    .update({
      run_count: ((rule as { run_count?: number }).run_count ?? 0) + 1,
      last_run_at: new Date().toISOString(),
      last_error: outcome.error ?? null,
    })
    .eq("id", ruleId);

  return {
    ok: !outcome.error,
    error: outcome.error,
    result: { conversationId: conversation.data.id, steps: outcome.steps.length },
  };
}

export function defaultDigestRunAt(hourUtc: number): Date {
  const d = new Date();
  d.setUTCHours(hourUtc, 0, 0, 0);
  if (d.getTime() < Date.now()) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export { env as schedulerEnv };
