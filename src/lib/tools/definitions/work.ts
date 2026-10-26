import { z } from "zod";
import { RRule } from "rrule";
import { DateTime } from "luxon";
import { registry, defineTool } from "../registry";

/**
 * Task and reminder tools.
 *
 * Reminders persist in Postgres and are drained by the scheduler, so they fire without a
 * browser open. Recurrence uses RRULE (RFC 5545) computed in the reminder's own IANA
 * timezone; the next occurrence is written back to `due_at` after each delivery.
 */

const taskCreate = defineTool({
  name: "task.create",
  description:
    "Create a tracked task from an instruction. Use for work that has multiple steps or that " +
    "you want to continue across sessions. Returns the task id.",
  category: "tasks",
  risk: "write",
  triggers: ["create a task", "add a task", "todo", "to-do", "track this", "set up a task"],
  schema: z.object({
    title: z.string().min(1).max(300),
    instruction: z.string().min(1).max(4000).describe("What the task should accomplish"),
    priority: z.number().int().min(1).max(9).optional(),
  }),
  async execute(args, ctx) {
    const { data, error } = await ctx.db
      .from("tasks")
      .insert({
        user_id: ctx.userId,
        conversation_id: ctx.conversationId ?? null,
        title: args.title,
        instruction: args.instruction,
        priority: args.priority ?? 5,
        status: "pending",
        source: "user",
      })
      .select("id, title, status, created_at")
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, verified: true, data };
  },
});

const taskUpdate = defineTool({
  name: "task.update",
  description: "Update an existing task's status, title or result summary.",
  category: "tasks",
  risk: "write",
  triggers: ["task is done", "complete the task", "update task", "cancel the task"],
  schema: z.object({
    task_id: z.string().uuid(),
    status: z
      .enum(["pending", "running", "completed", "failed", "cancelled"])
      .optional(),
    result_summary: z.string().max(4000).optional(),
  }),
  async execute(args, ctx) {
    const patch: Record<string, unknown> = {};
    if (args.status) {
      patch.status = args.status;
      if (args.status === "completed" || args.status === "failed") {
        patch.finished_at = new Date().toISOString();
      }
    }
    if (args.result_summary !== undefined) patch.result_summary = args.result_summary;
    if (!Object.keys(patch).length) return { ok: false, error: "Nothing to update." };

    const { data, error } = await ctx.db
      .from("tasks")
      .update(patch)
      .eq("id", args.task_id)
      .eq("user_id", ctx.userId)
      .select("id, status, result_summary")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: `No task found with id ${args.task_id}` };
    return { ok: true, verified: true, data };
  },
});

const taskList = defineTool({
  name: "task.list",
  description: "List the user's tasks, optionally filtered by status.",
  category: "tasks",
  risk: "read",
  triggers: ["my tasks", "list tasks", "what do i have to do", "pending tasks"],
  schema: z.object({
    status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async execute(args, ctx) {
    let query = ctx.db
      .from("tasks")
      .select("id, title, status, priority, due:created_at, result_summary, created_at")
      .eq("user_id", ctx.userId)
      .order("created_at", { ascending: false })
      .limit(args.limit ?? 20);
    if (args.status) query = query.eq("status", args.status);
    const { data, error } = await query;
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: { count: data?.length ?? 0, tasks: data ?? [] } };
  },
});

function parseDue(input: { due_at?: string; rrule?: string; timezone: string }, now: Date): Date {
  if (input.rrule) {
    const rule = RRule.fromString(input.rrule);
    const next = rule.after(now, true);
    if (!next) throw new Error("The recurrence rule has no future occurrences.");
    return next;
  }
  if (!input.due_at) throw new Error("Either due_at or rrule must be provided.");
  const parsed = DateTime.fromISO(input.due_at, { zone: "utc" });
  if (!parsed.isValid) throw new Error(`Could not parse due_at "${input.due_at}" as an ISO timestamp.`);
  return parsed.toJSDate();
}

const reminderCreate = defineTool({
  name: "reminder.create",
  description:
    "Schedule a one-time or recurring reminder. Provide an ISO-8601 due_at (with offset) or an " +
    "RRULE for recurrence. The reminder fires even if the app is closed.",
  category: "reminders",
  risk: "write",
  triggers: ["remind me", "reminder", "every day", "every week", "wake me", "don't let me forget"],
  schema: z.object({
    title: z.string().min(1).max(300),
    note: z.string().max(4000).optional(),
    due_at: z
      .string()
      .optional()
      .describe("ISO-8601 instant, e.g. 2026-11-03T09:00:00+05:30. Ignored when rrule is set."),
    timezone: z
      .string()
      .optional()
      .describe("IANA timezone used to interpret recurrence, e.g. Asia/Kolkata"),
    rrule: z
      .string()
      .optional()
      .describe(
        "RFC-5545 recurrence, e.g. FREQ=DAILY;BYHOUR=9;BYMINUTE=0  or  FREQ=WEEKLY;BYDAY=MO"
      ),
    ends_at: z.string().optional().describe("ISO-8601 instant after which recurrence stops"),
  }),
  async execute(args, ctx) {
    const timezone = args.timezone || (await resolveUserTimezone(ctx)) || "UTC";
    let due: Date;
    let rrule: string | null = null;

    try {
      if (args.rrule) {
        const base = args.rrule.includes("DTSTART") ? args.rrule : `DTSTART:${toUtcLocal(nowIso())}\n${args.rrule}`;
        const rule = RRule.fromString(base);
        if (rule.options.byhour.length && timezone !== "UTC") {
          // Re-anchor the rule in the user's timezone so 9am means 9am locally.
          const zoned = RRule.fromString(
            `DTSTART:${toUtcLocal(DateTime.now().setZone(timezone).toISO({ suppressMilliseconds: true })!)}\n${
              /DTSTART/.test(args.rrule) ? args.rrule.replace(/^DTSTART.*\n?/, "") : args.rrule
            }`
          );
          rrule = zoned.toString();
          due = zoned.after(new Date(), true) ?? zoned.after(new Date(Date.now() - 86400000), true)!;
        } else {
          rrule = rule.toString();
          const next = rule.after(new Date(), true);
          if (!next) throw new Error("The recurrence rule has no future occurrences — check FREQ/BYDAY.");
          due = next;
        }
      } else {
        due = parseDue({ due_at: args.due_at, timezone }, new Date());
      }
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }

    const { data, error } = await ctx.db
      .from("reminders")
      .insert({
        user_id: ctx.userId,
        title: args.title,
        note: args.note ?? null,
        due_at: due.toISOString(),
        timezone,
        rrule,
        recurrence_end_at: args.ends_at ?? null,
        status: "pending",
      })
      .select("id, title, due_at, timezone, rrule, status")
      .single();

    if (error) return { ok: false, error: error.message };
    return { ok: true, verified: true, data };
  },
});

const reminderList = defineTool({
  name: "reminder.list",
  description: "List upcoming, overdue and recently delivered reminders.",
  category: "reminders",
  risk: "read",
  triggers: ["my reminders", "list reminders", "what's next", "upcoming"],
  schema: z.object({
    include_delivered: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async execute(args, ctx) {
    const { data, error } = await ctx.db
      .from("reminders")
      .select("id, title, note, due_at, timezone, rrule, status, last_fired_at, fired_count")
      .eq("user_id", ctx.userId)
      .in("status", args.include_delivered ? ["pending", "snoozed", "delivered"] : ["pending", "snoozed"])
      .order("due_at", { ascending: true })
      .limit(args.limit ?? 20);
    if (error) return { ok: false, error: error.message };

    const now = Date.now();
    const rows = (data ?? []) as Array<{ due_at: string } & Record<string, unknown>>;
    return {
      ok: true,
      data: {
        count: rows.length,
        overdue: rows.filter((r) => new Date(r.due_at).getTime() < now).length,
        reminders: data,
      },
    };
  },
});

const reminderCancel = defineTool({
  name: "reminder.cancel",
  description: "Cancel a scheduled reminder so it no longer fires. Always confirms first.",
  category: "reminders",
  risk: "high",
  requiresApproval: true,
  triggers: ["cancel reminder", "delete reminder", "stop reminding"],
  schema: z.object({ id: z.string().uuid() }),
  async execute(args, ctx) {
    const { data, error } = await ctx.db
      .from("reminders")
      .update({ status: "cancelled" })
      .eq("id", args.id)
      .eq("user_id", ctx.userId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: `No pending reminder found with id ${args.id}` };
    return { ok: true, verified: true, data: { cancelled: args.id } };
  },
});

async function resolveUserTimezone(ctx: { db: import("@supabase/supabase-js").SupabaseClient; userId: string }): Promise<string | null> {
  const { data } = await ctx.db
    .from("profiles")
    .select("timezone")
    .eq("id", ctx.userId)
    .maybeSingle();
  return (data?.timezone as string) ?? null;
}

function nowIso(): string {
  return DateTime.now().toISO({ suppressMilliseconds: true })!;
}

/** Convert an ISO instant into a UTC-local DTSTART form (YYYYMMDDTHHMMSS). */
function toUtcLocal(iso: string): string {
  return DateTime.fromISO(iso, { zone: "utc" }).toFormat("yyyyMMdd'T'HHmmss");
}

export function registerWorkTools(): void {
  registry.registerAll([
    taskCreate,
    taskUpdate,
    taskList,
    reminderCreate,
    reminderList,
    reminderCancel,
  ]);
}
