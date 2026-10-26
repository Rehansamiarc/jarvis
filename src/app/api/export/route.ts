import { requireAuth, jsonError, jsonOk, readJson, ApiError } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Data portability and deletion (section 10).
 *
 * GET    — a single JSON document containing everything JARVIS stores for this account.
 * DELETE — irreversible removal of the account's data, gated behind an explicit typed
 *          confirmation so a stray fetch cannot wipe it.
 */
export async function GET() {
  try {
    const auth = await requireAuth();
    const uid = auth.userId;

    const pick = async (table: string) => {
      const { data, error } = await auth.db.from(table).select("*").eq("user_id", uid).limit(10_000);
      if (error) throw new Error(`${table}: ${error.message}`);
      return data ?? [];
    };

    const [profile, preferences] = await Promise.all([
      auth.db.from("profiles").select("*").eq("id", uid).maybeSingle(),
      auth.db.from("user_preferences").select("*").eq("user_id", uid).maybeSingle(),
    ]);

    const [conversations, memories, tasks, reminders, automations, contentPlans, integrations, notifications] =
      await Promise.all([
        pick("conversations"),
        pick("memories"),
        pick("tasks"),
        pick("reminders"),
        pick("automation_rules"),
        pick("content_plans"),
        pick("integrations"),
        pick("notifications"),
      ]);

    const { data: messages } = await auth.db
      .from("messages")
      .select("id, conversation_id, role, content, created_at")
      .eq("user_id", uid)
      .order("created_at", { ascending: true })
      .limit(20_000);

    const { data: docs } = await auth.db
      .from("knowledge_documents")
      .select("id, source_type, title, uri, status, created_at, updated_at")
      .eq("user_id", uid)
      .limit(2000);

    const payload = {
      exportedAt: new Date().toISOString(),
      format: "jarvis-export/v1",
      profile: profile.data,
      preferences: preferences.data,
      conversations: conversations ?? [],
      messages: messages ?? [],
      memories: memories ?? [],
      knowledgeDocuments: docs ?? [],
      tasks: tasks ?? [],
      reminders: reminders ?? [],
      automations: automations ?? [],
      contentPlans: contentPlans ?? [],
      notifications: notifications ?? [],
      // Ciphertext is deliberately excluded: it is unreadable without SECRET_ENCRYPTION_KEY
      // and shipping it around only creates a new place for a secret to leak.
      integrations: (integrations ?? []).map((row) => { const rest = { ...row }; delete rest.encrypted_credentials; return rest; }),
    };

    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="jarvis-export-${new Date().toISOString().slice(0, 10)}.json"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await requireAuth();
    const body = await readJson<{ confirm?: string }>(request);

    if (body.confirm !== "DELETE MY JARVIS DATA") {
      throw new ApiError(
        'Send { "confirm": "DELETE MY JARVIS DATA" } to permanently erase this account\'s data.',
        400,
        "confirmation_required"
      );
    }

    const uid = auth.userId;
    const tables = [
      "messages",
      "conversations",
      "memories",
      "knowledge_chunks",
      "knowledge_documents",
      "task_steps",
      "tasks",
      "reminders",
      "scheduled_jobs",
      "pending_actions",
      "action_logs",
      "execution_logs",
      "usage_logs",
      "notifications",
      "content_plans",
      "automation_rules",
      "integrations",
      "oauth_connections",
      "model_config",
    ];

    const deleted: Record<string, number> = {};
    const errors: string[] = [];

    // Service role is required here: several of these tables have no client DELETE policy
    // (credentials and audit rows), and deletion must cover them too.
    const admin = auth.admin ?? createAdminClient();

    for (const table of tables) {
      const column = table === "model_config" ? "user_id" : "user_id";
      const { data, error } = await admin
        .from(table)
        .delete()
        .eq(column, uid)
        .select("id");
      if (error) errors.push(`${table}: ${error.message}`);
      else deleted[table] = data?.length ?? 0;
    }

    await admin.from("profiles").delete().eq("id", uid);

    return jsonOk({ erased: deleted, errors, note: "Auth user row remains until you delete it from Supabase Auth." });
  } catch (error) {
    return jsonError(error);
  }
}
