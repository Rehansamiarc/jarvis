import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { env, MissingEnvError } from "@/lib/env";

/**
 * Service-role client. Bypasses Row Level Security, so it may only ever be constructed
 * inside a server module and must always be filtered by an authenticated user id (or
 * used by the cron worker, which legitimately spans users).
 *
 * Never imported by a client component — `server-only` makes that a build error.
 */
export function createAdminClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env();
  if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new MissingEnvError(
      ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
      "Server-side database access"
    );
  }
  return createSupabaseClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/** True when the server can act outside RLS (cron sweeps, credential writes). */
export function adminAvailable(): boolean {
  const e = env();
  return Boolean(e.NEXT_PUBLIC_SUPABASE_URL && e.SUPABASE_SERVICE_ROLE_KEY);
}
