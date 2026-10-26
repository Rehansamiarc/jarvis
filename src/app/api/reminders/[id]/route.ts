import { requireAuth, jsonError, jsonOk, readJson, ApiError } from "@/lib/api";
import { enqueueJob, jobKey } from "@/lib/scheduler/queue";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  note: z.string().max(4000).optional(),
  status: z.enum(["pending", "snoozed", "cancelled", "delivered"]).optional(),
  dueAt: z.string().optional(),
  /** Convenience: minutes from now, used by the snooze button. */
  snoozeMinutes: z.number().int().min(1).max(10080).optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth();
    const { id } = await context.params;
    const parsed = PatchSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new ApiError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        400,
        "validation"
      );
    }

    const patch: Record<string, unknown> = {};
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.note !== undefined) patch.note = parsed.data.note;
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;

    let newDue: Date | null = null;
    if (parsed.data.snoozeMinutes) {
      newDue = new Date(Date.now() + parsed.data.snoozeMinutes * 60_000);
      patch.due_at = newDue.toISOString();
      patch.status = "snoozed";
    } else if (parsed.data.dueAt) {
      const parsedDue = new Date(parsed.data.dueAt);
      if (Number.isNaN(parsedDue.getTime())) throw new ApiError("Invalid dueAt.", 400, "validation");
      newDue = parsedDue;
      patch.due_at = parsedDue.toISOString();
      patch.status = "pending";
    }

    const { data, error } = await auth.db
      .from("reminders")
      .update(patch)
      .eq("id", id)
      .eq("user_id", auth.userId)
      .select("id, title, due_at, status, timezone")
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new ApiError("Reminder not found.", 404, "not_found");

    if (newDue) {
      await enqueueJob(auth.db, {
        userId: auth.userId,
        kind: "reminder_due",
        runAt: newDue,
        payload: { reminderId: data.id },
        idempotencyKey: jobKey(data.id as string, newDue.toISOString()),
        priority: 3,
      });
      // The stale occurrence must not also fire.
      await auth.db
        .from("scheduled_jobs")
        .update({ status: "cancelled" })
        .eq("user_id", auth.userId)
        .in("status", ["scheduled", "claimed"])
        .like("idempotency_key", `reminder:${data.id}:%`);
    }

    if (patch.status === "cancelled") {
      await auth.db
        .from("scheduled_jobs")
        .update({ status: "cancelled" })
        .eq("user_id", auth.userId)
        .in("status", ["scheduled", "claimed", "running"])
        .like("idempotency_key", `reminder:${data.id}:%`);
    }

    return jsonOk({ reminder: data });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth();
    const { id } = await context.params;

    const { data, error } = await auth.db
      .from("reminders")
      .delete()
      .eq("id", id)
      .eq("user_id", auth.userId)
      .select("id");

    if (error) throw new Error(error.message);
    if (!data?.length) throw new ApiError("Reminder not found.", 404, "not_found");

    await auth.db
      .from("scheduled_jobs")
      .update({ status: "cancelled" })
      .eq("user_id", auth.userId)
      .in("status", ["scheduled", "claimed", "running"])
      .like("idempotency_key", `reminder:${id}:%`);

    return jsonOk({ deleted: id });
  } catch (error) {
    return jsonError(error);
  }
}
