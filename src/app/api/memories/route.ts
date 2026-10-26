import { requireAuth, jsonError, jsonOk, readJson, ApiError } from "@/lib/api";
import { saveMemory, searchMemories } from "@/lib/memory";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(8000),
  kind: z.enum(["preference", "fact", "project", "date", "goal", "instruction", "other"]).optional(),
  pinned: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export async function GET(request: Request) {
  try {
    const auth = await requireAuth();
    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.trim();
    const kind = url.searchParams.get("kind");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

    if (q) {
      const results = await searchMemories(auth.db, auth.userId, q, Math.min(limit, 20));
      return jsonOk({ memories: results, mode: "search" });
    }

    let query = auth.db
      .from("memories")
      .select(
        "id, kind, title, content, confidence, pinned, origin_ref, source, expires_at, created_at, updated_at, last_accessed_at, access_count"
      )
      .eq("user_id", auth.userId)
      .order("pinned", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (kind) query = query.eq("kind", kind);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return jsonOk({ memories: data ?? [], mode: "list" });
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
        `Invalid memory: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        400,
        "validation"
      );
    }

    const result = await saveMemory(auth.db, auth.userId, parsed.data);
    return jsonOk(result, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
