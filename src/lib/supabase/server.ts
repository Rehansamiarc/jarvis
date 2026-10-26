import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { env, MissingEnvError } from "@/lib/env";

/**
 * Request-scoped Supabase client bound to the caller's session cookie.
 *
 * Every query made through this client is filtered by Row Level Security with
 * `auth.uid() = user_id`, so application code cannot accidentally read or write another
 * account's rows even if it forgets a WHERE clause.
 */
export async function createClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = env();
  if (!NEXT_PUBLIC_SUPABASE_URL || !NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    throw new MissingEnvError(
      ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
      "Database connectivity"
    );
  }

  const cookieStore = await cookies();

  return createServerClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component where cookies are read-only. The middleware
          // is responsible for refreshing sessions, so this is safe to ignore.
        }
      },
    },
  });
}
