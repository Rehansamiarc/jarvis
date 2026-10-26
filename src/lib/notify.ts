import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * In-app notification centre. Emails (when configured and opted-in) are sent by the
 * scheduler, not here — a notification row is always created first so nothing is lost
 * if the outbound channel fails.
 */

export type NotificationInput = {
  kind?: "reminder" | "task" | "automation" | "integration_error" | "digest" | "system";
  level?: "info" | "success" | "warning" | "error";
  title: string;
  body?: string;
  link?: string;
  metadata?: Record<string, unknown>;
};

export async function notify(
  db: SupabaseClient,
  userId: string,
  input: NotificationInput
): Promise<string | null> {
  const { data, error } = await db
    .from("notifications")
    .insert({
      user_id: userId,
      kind: input.kind ?? "system",
      level: input.level ?? "info",
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      metadata: input.metadata ?? {},
    })
    .select("id")
    .single();

  if (error) {
    console.warn("[jarvis] notification insert failed:", error.message);
    return null;
  }
  return data.id as string;
}

export async function unreadCount(db: SupabaseClient, userId: string): Promise<number> {
  const { count } = await db
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("read_at", null);
  return count ?? 0;
}
