import { requireAuth, jsonError, jsonOk, readJson, ApiError } from "@/lib/api";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
  priority: z.number().int().min(1).max(9).optional(),
  result_summary: z.string().max(8000).optional(),
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

    const patch: Record<string, unknown> = { ...parsed.data };
    if (patch.status === "completed" || patch.status === "failed") {
      patch.finished_at = new Date().toISOString();
    }

    const { data, error } = await auth.db
      .from("tasks")
      .update(patch)
      .eq("id", id)
      .eq("user_id", auth.userId)
      .select("id, title, status, priority, result_summary, finished_at")
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new ApiError("Task not found.", 404, "not_found");
    return jsonOk({ task: data });
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
      .from("tasks")
      .delete()
      .eq("id", id)
      .eq("user_id", auth.userId)
      .select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new ApiError("Task not found.", 404, "not_found");
    return jsonOk({ deleted: id });
  } catch (error) {
    return jsonError(error);
  }
}
