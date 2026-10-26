import { requireAuth, jsonError, jsonOk, readJson, ApiError } from "@/lib/api";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(8000).optional(),
  kind: z.enum(["preference", "fact", "project", "date", "goal", "instruction", "other"]).optional(),
  pinned: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  expires_at: z.string().nullable().optional(),
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
        `Invalid update: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        400,
        "validation"
      );
    }

    const { data, error } = await auth.db
      .from("memories")
      .update(parsed.data)
      .eq("id", id)
      .eq("user_id", auth.userId)
      .select("id, title, content, kind, pinned, updated_at")
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new ApiError("Memory not found.", 404, "not_found");
    return jsonOk({ memory: data });
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
      .from("memories")
      .delete()
      .eq("id", id)
      .eq("user_id", auth.userId)
      .select("id");

    if (error) throw new Error(error.message);
    if (!data?.length) throw new ApiError("Memory not found.", 404, "not_found");
    return jsonOk({ deleted: id });
  } catch (error) {
    return jsonError(error);
  }
}
