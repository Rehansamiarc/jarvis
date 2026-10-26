import { requireAuth, jsonError, jsonOk, readJson, ApiError } from "@/lib/api";
import { enqueueJob, jobKey } from "@/lib/scheduler/queue";
import { RRule } from "rrule";
import { DateTime } from "luxon";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  title: z.string().min(1).max(300),
  note: z.string().max(4000).optional(),
  dueAt: z.string().optional(),
  timezone: z.string().max(64).optional(),
  rrule: z.string().max(500).optional(),
  endsAt: z.string().optional(),
  kind: z.enum(["once", "recurring"]).optional(),
});

export async function GET(request: Request) {
  try {
    const auth = await requireAuth();
    const url = new URL(request.url);
    const status = url.searchParams.get("status");

    let query = auth.db
      .from("reminders")
      .select("id, title, note, due_at, timezone, rrule, status, fired_count, last_fired_at, attempts, last_error, created_at, updated_at")
      .eq("user_id", auth.userId)
      .order("due_at", { ascending: true })
      .limit(200);

    if (status) query = query.eq("status", status);
    else query = query.in("status", ["pending", "snoozed", "delivered", "failed"]);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    // `is_overdue` is computed here rather than in the browser so the judgement comes from
    // the same clock the sweep uses — a device with a skewed clock cannot mislabel a
    // reminder as late or on time.
    const now = Date.now();
    const reminders = (data ?? []).map((r) => ({
      ...r,
      is_overdue: r.status === "pending" && new Date(r.due_at).getTime() < now,
    }));

    return jsonOk({
      reminders,
      overdue: reminders.filter((r) => r.is_overdue).length,
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAuth();
    const parsed = CreateSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new ApiError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        400,
        "validation"
      );
    }
    const body = parsed.data;
    const timezone = body.timezone || (await resolveTimezone(auth.userId, auth)) || "UTC";

    let dueAt: Date;
    let rrule: string | null = null;

    try {
      if (body.rrule) {
        rrule = normaliseRule(body.rrule, timezone);
        const next = RRule.fromString(rrule).after(new Date(), true);
        if (!next) throw new Error("This recurrence has no future occurrences — check FREQ/BYDAY.");
        dueAt = next;
      } else {
        if (!body.dueAt) throw new ApiError("dueAt is required for a one-time reminder.", 400, "validation");
        const parsedDue = DateTime.fromISO(body.dueAt);
        if (!parsedDue.isValid) throw new ApiError(`Could not parse dueAt "${body.dueAt}".`, 400, "validation");
        dueAt = parsedDue.toJSDate();
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError((error as Error).message, 400, "invalid_rrule");
    }

    if (dueAt.getTime() < Date.now() - 5 * 60_000) {
      throw new ApiError("dueAt is in the past. Pick a future time.", 400, "past_due");
    }

    const { data, error } = await auth.db
      .from("reminders")
      .insert({
        user_id: auth.userId,
        title: body.title,
        note: body.note ?? null,
        due_at: dueAt.toISOString(),
        timezone,
        rrule,
        recurrence_end_at: body.endsAt ?? null,
        status: "pending",
      })
      .select("id, title, note, due_at, timezone, rrule, status, created_at")
      .single();

    if (error) throw new Error(error.message);

    const jobId = await enqueueJob(auth.db, {
      userId: auth.userId,
      kind: "reminder_due",
      runAt: dueAt,
      payload: { reminderId: data.id },
      idempotencyKey: jobKey(data.id as string, dueAt.toISOString()),
      priority: 3,
    });

    return jsonOk({ reminder: data, jobId }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

/** Anchors an RRULE to a DTSTART so RRule can evaluate it, keeping the user's timezone. */
function normaliseRule(rule: string, timezone: string): string {
  const cleaned = rule.replace(/^DTSTART[^\n]*\n?/, "").trim();
  const now = DateTime.now().setZone(timezone);
  const stamp = (now.isValid ? now : DateTime.now().setZone("utc"))
    .toUTC()
    .toFormat("yyyyMMdd'T'HHmmss");
  const candidate = `DTSTART:${stamp}\n${cleaned}`;
  const parsed = RRule.fromString(candidate); // throws on malformed input
  void parsed;
  return candidate;
}

async function resolveTimezone(
  userId: string,
  auth: { db: import("@supabase/supabase-js").SupabaseClient }
): Promise<string | null> {
  const { data } = await auth.db.from("profiles").select("timezone").eq("id", userId).maybeSingle();
  return (data?.timezone as string) ?? null;
}
