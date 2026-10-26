import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parsePermissionMode, type PermissionMode } from "@/lib/permissions/policy";
import { connectionStatuses } from "@/lib/integrations/connections";

/**
 * Everything the agent needs to know about *who* is asking, loaded in two queries.
 * Shared by the chat route, the approval route and scheduled automations so all three
 * enforce exactly the same policy.
 */

export interface RuntimeContext {
  userId: string;
  permissionMode: PermissionMode;
  personality: string;
  language: string;
  timezone: string;
  automationsPaused: boolean;
  connections: Record<string, string>;
  email: string;
  fullName: string | null;
}

export async function loadRuntimeContext(
  db: SupabaseClient,
  userId: string
): Promise<RuntimeContext> {
  const [profile, prefs, connections] = await Promise.all([
    db.from("profiles").select("email, full_name, timezone").eq("id", userId).maybeSingle(),
    db
      .from("user_preferences")
      .select("permission_mode, personality, language, automations_paused")
      .eq("user_id", userId)
      .maybeSingle(),
    connectionStatuses(db, userId),
  ]);

  return {
    userId,
    permissionMode: parsePermissionMode(prefs.data?.permission_mode),
    personality:
      prefs.data?.personality ??
      "witty, concise, technically precise — the JARVIS register",
    language: prefs.data?.language ?? "en-US",
    timezone: profile.data?.timezone ?? "UTC",
    automationsPaused: prefs.data?.automations_paused ?? false,
    connections,
    email: profile.data?.email ?? "",
    fullName: profile.data?.full_name ?? null,
  };
}

/** Reads the authenticated user id from a Supabase client, or null when signed out. */
export async function requireUser(db: SupabaseClient): Promise<string | null> {
  const {
    data: { user },
  } = await db.auth.getUser();
  return user?.id ?? null;
}
