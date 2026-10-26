import { requireAuth, jsonError, jsonOk, readJson, ApiError } from "@/lib/api";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  title: z.string().min(1).max(300),
  instruction: z.string().min(1).max(8000),
  priority: z.number().int().min(1).max(9).optional(),
  dueAt: z.string().datetime().optional(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
});

export async function GET(request: Request) {
  try {
    const auth = await requireAuth();
    const url = new URL(request.url);
    const status = url.searchParams.get("status");

    let query = auth.db
      .from("tasks")
      .select(
        "id, title, instruction, status, risk, priority, source, result_summary, error, created_at, updated_at, finished_at, plan"
      )
      .eq("user_id", auth.userId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return jsonOk({ tasks: data ?? [] });
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

    const { data, error } = await auth.db
      .from("tasks")
      .insert({
        user_id: auth.userId,
        title: parsed.data.title,
        instruction: parsed.data.instruction,
        priority: parsed.data.priority ?? 5,
        status: parsed.data.status ?? "pending",
        source: "user",
      })
      .select("id, title, status, priority, created_at")
      .single();

    if (error) throw new Error(error.message);
    return jsonOk({ task: data }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
