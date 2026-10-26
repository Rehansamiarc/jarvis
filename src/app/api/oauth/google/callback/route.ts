import { NextResponse, type NextRequest } from "next/server";
import { env, appUrl } from "@/lib/env";
import { seal, unseal } from "@/lib/crypto/secrets";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { notify } from "@/lib/notify";
import { GOOGLE_OAUTH_COOKIE, fetchGoogleProfile, hasScope } from "@/lib/oauth/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/**
 * OAuth callback.
 *
 * On success the tokens are sealed with AES-256-GCM before storage; only non-secret
 * profile fields ever reach the `integrations.config` JSON that the UI is allowed to read.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const fail = (message: string) => redirect(`/connections?error=${encodeURIComponent(message)}`);

  if (oauthError) {
    return fail(url.searchParams.get("error_description") || `Google returned "${oauthError}".`);
  }
  if (!code || !state) return fail("Missing authorization code or state.");

  const e = env();
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) {
    return fail("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured on the server.");
  }

  const cookie = request.cookies.get(GOOGLE_OAUTH_COOKIE)?.value;
  if (!cookie || cookie !== state) {
    return fail("State mismatch — the connection attempt expired or was replayed. Try again.");
  }

  let payload: { u: string; s: string; r: string; t: number };
  try {
    payload = JSON.parse(unseal(state) ?? "") as typeof payload;
  } catch {
    return fail("State could not be verified.");
  }
  if (!payload?.u || Date.now() - payload.t > 10 * 60_000) {
    return fail("The connection attempt expired. Sign in and try again.");
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: e.GOOGLE_CLIENT_ID,
        client_secret: e.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${appUrl()}/api/oauth/google/callback`,
        grant_type: "authorization_code",
      }),
      cache: "no-store",
    });

    const tokens = (await tokenResponse.json()) as TokenResponse;
    if (!tokenResponse.ok || !tokens.access_token) {
      return fail(
        `Token exchange failed: ${tokens.error ?? tokenResponse.status} ${tokens.error_description ?? ""}`.trim()
      );
    }

    const granted = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
    const profile = await fetchGoogleProfile(tokens.access_token);

    if (e.GOOGLE_HOSTED_DOMAIN && profile?.hd && profile.hd !== e.GOOGLE_HOSTED_DOMAIN) {
      return fail(`This OAuth client is restricted to ${e.GOOGLE_HOSTED_DOMAIN}.`);
    }

    const db = await createClient();
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user || user.id !== payload.u) {
      return fail("Your session changed during the connection flow. Sign in and try again.");
    }

    const admin = createAdminClient();
    const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3500) * 1000).toISOString();

    const { error: upsertError } = await admin.from("oauth_connections").upsert(
      {
        user_id: user.id,
        provider: "google",
        status: "connected",
        granted_scopes: granted,
        access_token_encrypted: seal(tokens.access_token),
        refresh_token_encrypted: tokens.refresh_token ? seal(tokens.refresh_token) : null,
        expires_at: expiresAt,
        token_type: tokens.token_type ?? "Bearer",
        external_subject: profile?.sub ?? null,
        external_profile: {
          email: profile?.email ?? null,
          name: profile?.name ?? null,
          picture: profile?.picture ?? null,
        },
        revoked_at: null,
        last_refreshed_at: new Date().toISOString(),
      },
      { onConflict: "user_id,provider" }
    );
    if (upsertError) throw new Error(upsertError.message);

    // Mirror into the feature-level rows that the tool policy reads.
    const featureRows: Array<{ provider: "youtube" | "gmail"; marker: string }> = [
      { provider: "youtube", marker: "youtube.readonly" },
      { provider: "gmail", marker: "gmail.send" },
    ];

    for (const feature of featureRows) {
      if (!hasScope(granted, feature.marker)) continue;
      const { error: integrationError } = await admin.from("integrations").upsert(
        {
          user_id: user.id,
          provider: feature.provider,
          label: "default",
          status: "connected",
          granted_scopes: granted.filter((s) => s.includes(feature.provider === "gmail" ? "gmail" : "youtube")),
          config: {
            subject: profile?.sub ?? null,
            account: profile?.email ?? null,
            connectedVia: "google_oauth",
          },
          connected_at: new Date().toISOString(),
          disconnected_at: null,
          last_error: null,
        },
        { onConflict: "user_id,provider,label" }
      );
      if (integrationError) {
        console.error("[jarvis] failed to record integration:", integrationError.message);
      }
    }

    await notify(admin, user.id, {
      kind: "system",
      level: "success",
      title: "Google account connected",
      body: granted.length ? `Granted ${granted.length} scope(s).` : "Connected.",
      link: "/connections",
      metadata: { scopeCount: granted.length },
    });

    const response = redirect(`/connections?connected=google`);
    response.cookies.delete(GOOGLE_OAUTH_COOKIE);
    return response;
  } catch (error) {
    console.error("[jarvis] oauth callback failed:", (error as Error).message);
    return fail((error as Error).message);
  }
}

function redirect(path: string): NextResponse {
  const response = NextResponse.redirect(`${appUrl()}${path}`);
  response.headers.set("cache-control", "no-store");
  return response;
}
