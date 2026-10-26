import { NextResponse } from "next/server";
import { requireAuth, jsonError, ApiError } from "@/lib/api";
import { env, appUrl } from "@/lib/env";
import { seal } from "@/lib/crypto/secrets";
import { GOOGLE_OAUTH_COOKIE } from "@/lib/oauth/google";
import {
  GOOGLE_SCOPE_LIST,
  GOOGLE_SCOPES_GMAIL_ONLY,
  GOOGLE_SCOPES_YOUTUBE_ONLY,
} from "@/lib/integrations/connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPE_SETS: Record<string, string[]> = {
  all: GOOGLE_SCOPE_LIST,
  youtube: GOOGLE_SCOPES_YOUTUBE_ONLY,
  gmail: GOOGLE_SCOPES_GMAIL_ONLY,
};

/**
 * Starts the Google OAuth authorization-code flow.
 *
 * Least privilege: the caller picks the narrowest scope set for the feature it wants
 * (`?scope=youtube` or `?scope=gmail`) rather than always asking for everything.
 * `access_type=offline` + `prompt=consent` guarantees a refresh token so connections do
 * not silently expire into a broken integration.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireAuth();
    const e = env();
    if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) {
      throw new ApiError(
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server " +
          `and add the redirect URI ${appUrl()}/api/oauth/google/callback to the OAuth client.`,
        503,
        "not_configured"
      );
    }

    const url = new URL(request.url);
    const scopeKey = url.searchParams.get("scope") ?? "all";
    const scopes = SCOPE_SETS[scopeKey] ?? SCOPE_SETS.all;
    const redirectUri = `${appUrl()}/api/oauth/google/callback`;

    // Sealed state ties the callback to this user and this browser, and blocks CSRF.
    const state = seal(JSON.stringify({ u: auth.userId, s: scopeKey, r: redirectUri, t: Date.now() }));

    const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorize.searchParams.set("client_id", e.GOOGLE_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", scopes.join(" "));
    authorize.searchParams.set("access_type", "offline");
    authorize.searchParams.set("prompt", "consent");
    authorize.searchParams.set("include_granted_scopes", "true");
    authorize.searchParams.set("state", state);
    if (e.GOOGLE_HOSTED_DOMAIN) authorize.searchParams.set("hd", e.GOOGLE_HOSTED_DOMAIN);

    const response = NextResponse.redirect(authorize.toString());
    response.cookies.set(GOOGLE_OAUTH_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 600,
      path: "/",
    });
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
