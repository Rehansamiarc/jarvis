import { requireAuth, jsonError, jsonOk } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireAuth();
    const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 50), 200);

    const { data, error } = await auth.db
      .from("conversations")
      .select("id, title, summary, archived_at, last_message_at, created_at, updated_at")
      .eq("user_id", auth.userId)
      .is("archived_at", null)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(limit);

    if (error) throw new Error(error.message);
    return jsonOk({ conversations: data ?? [] });
  } catch (error) {
    return jsonError(error);
  }
}
