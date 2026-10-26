import { requireAuth, jsonError, jsonOk, readJson, ApiError } from "@/lib/api";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireAuth();
    const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 40), 100);

    const { data, error } = await auth.db
      .from("notifications")
      .select("id, kind, level, title, body, link, metadata, read_at, created_at")
      .eq("user_id", auth.userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);

    const { count: unread } = await auth.db
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", auth.userId)
      .is("read_at", null);

    return jsonOk({ notifications: data ?? [], unread: unread ?? 0 });
  } catch (error) {
    return jsonError(error);
  }
}

const PatchSchema = z.object({
  ids: z.array(z.string().uuid()).max(200).optional(),
  all: z.boolean().optional(),
});

export async function PATCH(request: Request) {
  try {
    const auth = await requireAuth();
    const parsed = PatchSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new ApiError("Invalid body.", 400, "validation");

    let query = auth.db
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", auth.userId)
      .is("read_at", null);

    if (parsed.data.all) {
      // no id filter
    } else if (parsed.data.ids?.length) {
      query = query.in("id", parsed.data.ids);
    } else {
      throw new ApiError("Provide ids or all:true.", 400, "validation");
    }

    const { error } = await query;
    if (error) throw new Error(error.message);
    return jsonOk({ marked: true });
  } catch (error) {
    return jsonError(error);
  }
}
