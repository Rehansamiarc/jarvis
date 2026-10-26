import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Handles the Supabase auth code redirect (magic link / email OTP / OAuth through
 * Supabase). Exchanges the code for a session cookie, then continues to the deep link
 * the user originally asked for.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") || "/dashboard";
  const errorDescription = url.searchParams.get("error_description");

  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  const redirect = (path: string) =>
    NextResponse.redirect(`${appUrl()}${path}`, { headers: { "cache-control": "no-store" } });

  if (errorDescription) {
    return redirect(`/login?error=${encodeURIComponent(errorDescription)}`);
  }
  if (!code) {
    return redirect(`/login?error=${encodeURIComponent("Missing authorization code.")}`);
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return redirect(`/login?error=${encodeURIComponent(error.message)}`);
    return redirect(safeNext);
  } catch (error) {
    return redirect(`/login?error=${encodeURIComponent((error as Error).message)}`);
  }
}
