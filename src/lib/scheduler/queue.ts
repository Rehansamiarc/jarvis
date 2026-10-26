import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Enqueue helpers.
 *
 * Every job carries an idempotency key derived from its logical identity (which
 * reminder, at which occurrence), so re-scheduling the same work is a no-op rather than
 * a duplicate execution.
 */

export type JobKind =
  | "reminder_due"
  | "task_run"
  | "automation"
  | "digest"
  | "reindex"
  | "maintenance"
  | "webhook";

export async function enqueueJob(
  db: SupabaseClient,
  input: {
    userId: string;
    kind: JobKind;
    runAt: Date | string;
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
    priority?: number;
    maxAttempts?: number;
  }
): Promise<string | null> {
  const row = {
    user_id: input.userId,
    kind: input.kind,
    status: "scheduled" as const,
    run_at: new Date(input.runAt).toISOString(),
    payload: input.payload ?? {},
    idempotency_key: input.idempotencyKey ?? null,
    priority: input.priority ?? 5,
    max_attempts: input.maxAttempts ?? 3,
  };

  // The uniqueness guarantee comes from a *partial* unique index, which PostgREST's
  // ON CONFLICT inference cannot target — so we check first and treat a lost race as
  // success.
  if (input.idempotencyKey) {
    const { data: existing } = await db
      .from("scheduled_jobs")
      .select("id")
      .eq("user_id", input.userId)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (existing?.id) return existing.id as string;
  }

  const { data, error } = await db.from("scheduled_jobs").insert(row).select("id").maybeSingle();

  if (error) {
    if (/duplicate key/i.test(error.message) && input.idempotencyKey) {
      const { data: existing } = await db
        .from("scheduled_jobs")
        .select("id")
        .eq("user_id", input.userId)
        .eq("idempotency_key", input.idempotencyKey)
        .maybeSingle();
      return (existing?.id as string) ?? null;
    }
    console.warn("[jarvis] enqueueJob failed:", error.message);
    return null;
  }
  return (data?.id as string) ?? null;
}

/**
 * Missed-reminder recovery: ensure every pending reminder that is due (or soon due) has a
 * queued job. Runs at the start of each sweep, so a reminder whose job was lost — or that
 * was created while no cron ran — still fires.
 */
export async function reconcileReminders(
  db: SupabaseClient,
  options: { horizonMinutes?: number } = {}
): Promise<{ enqueued: number; orphaned: number }> {
  const horizon = new Date(Date.now() + (options.horizonMinutes ?? 60 * 24 * 7));

  const { data: reminders, error } = await db
    .from("reminders")
    .select("id, user_id, due_at, rrule, status")
    .in("status", ["pending", "snoozed"])
    .lte("due_at", horizon.toISOString())
    .limit(500);

  if (error || !reminders?.length) return { enqueued: 0, orphaned: 0 };

  const userIds = [...new Set(reminders.map((r) => r.user_id as string))];
  const keys = reminders.map((r) => jobKey(r.id as string, r.due_at as string));

  const { data: existing } = await db
    .from("scheduled_jobs")
    .select("idempotency_key")
    .in("user_id", userIds)
    .in("idempotency_key", keys)
    .in("status", ["scheduled", "claimed", "running"]);

  const present = new Set((existing ?? []).map((j) => j.idempotency_key as string));
  let enqueued = 0;

  for (const r of reminders) {
    const key = jobKey(r.id as string, r.due_at as string);
    if (present.has(key)) continue;
    const id = await enqueueJob(db, {
      userId: r.user_id as string,
      kind: "reminder_due",
      runAt: r.due_at as string,
      payload: { reminderId: r.id },
      idempotencyKey: key,
      priority: 3,
    });
    if (id) enqueued++;
  }

  return { enqueued, orphaned: reminders.length - enqueued - present.size };
}

export function jobKey(reminderId: string, dueAt: string | Date): string {
  const iso = new Date(dueAt).toISOString();
  return `reminder:${reminderId}:${iso}`;
}
