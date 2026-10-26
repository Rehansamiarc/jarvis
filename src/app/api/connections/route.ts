import { requireAuth, jsonError, jsonOk, readJson, ApiError } from "@/lib/api";
import { env, availability } from "@/lib/env";
import { writeCredentials, connectionStatuses } from "@/lib/integrations/connections";
import { wpSiteStatus, WordPressError } from "@/lib/integrations/wordpress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ConfigureBody {
  provider: "wordpress" | "serper" | "resend";
  siteUrl?: string;
  username?: string;
  appPassword?: string;
}

/**
 * Connected-accounts API (section 11).
 *
 * GET    — status per provider plus whether the server can actually back it (so the UI
 *          never shows a green "connected" for something with no credentials).
 * POST   — store a WordPress Application Password. It is validated against the live site
 *          *before* being sealed and saved, so a typo fails here rather than at 2am.
 * DELETE — disconnect/revoke: wipes ciphertext, marks rows disconnected, and for Google
 *          revokes the grant at Google so the token stops working.
 */
export async function GET() {
  try {
    const auth = await requireAuth();
    const connections = await connectionStatuses(auth.db, auth.userId);

    const { data: rows } = await auth.db
      .from("integrations")
      .select("provider, label, status, config, granted_scopes, connected_at, last_checked_at, last_error")
      .eq("user_id", auth.userId)
      .order("connected_at", { ascending: false, nullsFirst: false });

    const { data: oauth } = await auth.db
      .from("oauth_connections")
      .select("provider, status, granted_scopes, expires_at, external_profile, last_refreshed_at")
      .eq("user_id", auth.userId);

    return jsonOk({
      connections,
      integrations: rows ?? [],
      oauth: (oauth ?? []).map((o) => ({
        provider: o.provider,
        status: o.status,
        scopes: o.granted_scopes,
        expiresAt: o.expires_at,
        account: (o.external_profile as { email?: string } | null)?.email ?? null,
        lastRefreshedAt: o.last_refreshed_at,
      })),
      serverCapabilities: availability(),
      googleRedirectUri: `${env().NEXT_PUBLIC_APP_URL ?? ""}/api/oauth/google/callback`,
      configuredEnv: {
        wordpress: Boolean(env().WORDPRESS_SITE_URL),
        serper: Boolean(env().SERPER_API_KEY),
        resend: Boolean(env().RESEND_API_KEY),
        google: Boolean(env().GOOGLE_CLIENT_ID),
        serviceRole: Boolean(env().SUPABASE_SERVICE_ROLE_KEY),
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAuth();
    const body = await readJson<ConfigureBody>(request);

    if (body.provider !== "wordpress") {
      throw new ApiError(
        `POST only supports provider="wordpress". "${body.provider}" is configured through environment variables or an OAuth redirect.`,
        400,
        "unsupported"
      );
    }

    const siteUrl = (body.siteUrl ?? "").trim().replace(/\/$/, "");
    const username = (body.username ?? "").trim();
    const appPassword = (body.appPassword ?? "").trim();

    if (!/^https?:\/\//.test(siteUrl)) {
      throw new ApiError("siteUrl must start with http:// or https://", 400, "invalid_site");
    }
    if (!username || !appPassword) {
      throw new ApiError("username and appPassword are required.", 400, "missing_fields");
    }

    // Validate against the real site before persisting anything.
    const probe = await wpSiteStatus({ siteUrl, username, appPassword });
    if (!probe.ok) {
      throw new ApiError(
        `Could not reach ${siteUrl}/wp-json/: ${probe.error}. Check the URL, that the REST API is enabled, and that the application password is correct.`,
        400,
        "wordpress_unreachable"
      );
    }

    if (!availability().encryption) {
      throw new ApiError(
        "SECRET_ENCRYPTION_KEY is not set, so credentials cannot be stored safely. Set it and retry.",
        503,
        "no_encryption_key"
      );
    }

    await writeCredentials(auth.admin ?? auth.db, auth.userId, "wordpress", {
      status: "connected",
      config: {
        siteUrl,
        siteName: probe.name ?? null,
        namespaces: probe.namespaces ?? [],
      },
      secrets: { username, appPassword },
      scopes: ["read", "write", "edit_posts", "upload_files", "moderate_comments"],
    });

    return jsonOk({
      connected: true,
      site: { name: probe.name, url: probe.url ?? siteUrl },
      message: "WordPress validated and stored (encrypted, server-side only).",
    });
  } catch (error) {
    if (error instanceof WordPressError) {
      return jsonError(new ApiError(error.message, 400, "wordpress_error"));
    }
    return jsonError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await requireAuth();
    const provider = new URL(request.url).searchParams.get("provider");
    if (!provider) throw new ApiError("provider query parameter is required.", 400, "bad_request");

    const { error } = await auth.db
      .from("integrations")
      .update({
        status: "revoked",
        encrypted_credentials: null,
        disconnected_at: new Date().toISOString(),
        granted_scopes: [],
        last_error: null,
      })
      .eq("user_id", auth.userId)
      .eq("provider", provider);
    if (error) throw new Error(error.message);

    if (provider === "google" || provider === "youtube" || provider === "gmail") {
      await auth.db
        .from("oauth_connections")
        .update({ status: "revoked", revoked_at: new Date().toISOString(), access_token_encrypted: null, refresh_token_encrypted: null })
        .eq("user_id", auth.userId)
        .eq("provider", "google");

      for (const p of ["youtube", "gmail"]) {
        await auth.db
          .from("integrations")
          .update({ status: "revoked", disconnected_at: new Date().toISOString() })
          .eq("user_id", auth.userId)
          .eq("provider", p);
      }

      // Best effort server-side revocation so a leaked token stops working immediately.
      if (auth.admin) {
        try {
          const { getGoogleAccessToken } = await import("@/lib/integrations/connections");
          const token = await getGoogleAccessToken(auth.admin, auth.userId).catch(() => null);
          if (token) {
            await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
              method: "POST",
              cache: "no-store",
            });
          }
        } catch {
          /* revocation is best effort */
        }
      }
    }

    return jsonOk({ disconnected: provider });
  } catch (error) {
    return jsonError(error);
  }
}
