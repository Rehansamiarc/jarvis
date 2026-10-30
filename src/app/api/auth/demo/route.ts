import "server-only";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminAvailable, createAdminClient } from "@/lib/supabase/admin";

/**
 * Demo sign-in.
 *
 * A brand new deployment has no users, and Supabase's default flow requires clicking a
 * confirmation link before the first session exists — which makes a fresh project look
 * broken. This route provisions one clearly-labelled demo account (email pre-confirmed)
 * and signs the caller into it, so the interface can be explored immediately.
 *
 * Security posture:
 *   * The account is ordinary: RLS still scopes every row to its own `user_id`, so demo
 *     data is never mixed into a real account, and a real account's data is never
 *     reachable from the demo session.
 *   * Anyone with the URL can enter the demo account, so nothing sensitive may be
 *     connected to it. Set `DEMO_LOGIN=off` to disable the route entirely (it then
 *     answers 404 and the login page hides the button).
 *   * Uses the service role only to create/re-arm the demo user; every read and write
 *     afterwards goes through the session client, exactly like a normal sign-in.
 */

const DEMO_EMAIL = process.env.DEMO_EMAIL?.trim() || "demo@jarvis.local";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "jarvis-demo-2026";

function demoEnabled(): boolean {
  const flag = (process.env.DEMO_LOGIN ?? "").trim().toLowerCase();
  return flag !== "off" && flag !== "false" && flag !== "0";
}

/** Re-arm an existing demo user whose password drifted from the configured one. */
async function resetDemoPassword(email: string, password: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) return `Could not list users: ${error.message}`;

  const existing = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!existing) return `Demo user ${email} was not found after creation.`;

  const { error: updateError } = await admin.auth.admin.updateUserById(existing.id, {
    password,
    email_confirm: true,
  });
  return updateError ? `Could not reset the demo password: ${updateError.message}` : null;
}

export async function POST() {
  if (!demoEnabled()) {
    return NextResponse.json({ error: "Demo sign-in is disabled on this deployment." }, { status: 404 });
  }

  const supabase = await createClient();

  const first = await supabase.auth.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  if (!first.error) {
    return NextResponse.json({ ok: true, redirect: "/dashboard", email: DEMO_EMAIL });
  }

  // The account does not exist yet (or its password changed). Creating it needs the
  // service role: an anonymous client may not confirm an email address.
  if (!adminAvailable()) {
    return NextResponse.json(
      {
        error:
          "Demo sign-in needs SUPABASE_SERVICE_ROLE_KEY on the server to provision the demo account. " +
          "Add it in Vercel → Settings → Environment Variables, or sign up with your own email instead.",
      },
      { status: 503 }
    );
  }

  const admin = createAdminClient();
  const { error: createError } = await admin.auth.admin.createUser({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    email_confirm: true,
    user_metadata: { demo: true, display_name: "Demo" },
  });

  if (createError && !/already|registered|exists/i.test(createError.message)) {
    return NextResponse.json({ error: `Could not create the demo account: ${createError.message}` }, { status: 500 });
  }

  if (createError) {
    const resetFailure = await resetDemoPassword(DEMO_EMAIL, DEMO_PASSWORD);
    if (resetFailure) return NextResponse.json({ error: resetFailure }, { status: 500 });
  }

  const second = await supabase.auth.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  if (second.error) {
    return NextResponse.json(
      { error: `Demo account exists but sign-in failed: ${second.error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, redirect: "/dashboard", email: DEMO_EMAIL });
}

/** Lets the login page hide the button instead of offering something that 404s. */
export async function GET() {
  return NextResponse.json({
    enabled: demoEnabled(),
    ready: demoEnabled() && adminAvailable(),
    email: demoEnabled() ? DEMO_EMAIL : null,
  });
}
