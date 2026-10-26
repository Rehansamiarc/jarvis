import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { unseal, seal } from "@/lib/crypto/secrets";

/**
 * Connection helpers shared by every integration.
 *
 * Status is read through the caller's RLS-scoped client (so a user only ever sees their
 * own connections), while token *values* are read with the service-role client and only
 * ever leave this module as an in-memory string used to build an outbound request.
 */

export type ConnectionMap = Record<string, string>;

export async function connectionStatuses(
  db: SupabaseClient,
  userId: string
): Promise<ConnectionMap> {
  const [integrations, oauth] = await Promise.all([
    db
      .from("integrations")
      .select("provider, status, config")
      .eq("user_id", userId),
    db
      .from("oauth_connections")
      .select("provider, status, expires_at")
      .eq("user_id", userId),
  ]);

  const map: ConnectionMap = {};

  const envFallbacks: Array<[string, boolean]> = [
    ["wordpress", Boolean(env().WORDPRESS_SITE_URL && env().WORDPRESS_USERNAME && env().WORDPRESS_APP_PASSWORD)],
    ["serper", Boolean(env().SERPER_API_KEY)],
    ["resend", Boolean(env().RESEND_API_KEY)],
  ];

  for (const [provider, configured] of envFallbacks) {
    if (configured) map[provider] = "connected";
  }

  for (const row of integrations.data ?? []) {
    if (row.status === "connected") map[row.provider] = "connected";
    else if (row.status) map[row.provider] = row.status;
  }

  for (const row of oauth.data ?? []) {
    const expired = row.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false;
    if (row.status === "connected" && expired && !hasRefreshTokenFallback(row.provider)) {
      map[row.provider] = "needs_reauth";
    } else if (row.status) {
      map[row.provider] = row.status;
    }
  }

  return map;
}

function hasRefreshTokenFallback(provider: string): boolean {
  return provider === "google";
}

export interface StoredCredentials {
  /** WordPress: { username, appPassword, siteUrl }  Google: { clientId?, clientSecret? } */
  secrets: Record<string, string>;
  config: Record<string, unknown>;
}

/** Service-role read of encrypted credentials. Never returned to a client. */
export async function readCredentials(
  admin: SupabaseClient,
  userId: string,
  provider: string
): Promise<StoredCredentials | null> {
  const { data, error } = await admin
    .from("integrations")
    .select("config, encrypted_credentials")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();

  if (error || !data) return null;

  let secrets: Record<string, string> = {};
  if (data.encrypted_credentials) {
    try {
      secrets = JSON.parse(unseal(data.encrypted_credentials) ?? "{}");
    } catch {
      console.error(`[jarvis] failed to decrypt ${provider} credentials — key rotation needed`);
      return null;
    }
  }
  return { secrets, config: (data.config ?? {}) as Record<string, unknown> };
}

export async function writeCredentials(
  admin: SupabaseClient,
  userId: string,
  provider: string,
  input: { config?: Record<string, unknown>; secrets?: Record<string, string>; status?: string; scopes?: string[] }
): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (input.config) payload.config = input.config;
  if (input.status) payload.status = input.status;
  if (input.scopes) payload.granted_scopes = input.scopes;
  if (input.secrets) payload.encrypted_credentials = seal(JSON.stringify(input.secrets));
  payload.connected_at = new Date().toISOString();
  payload.user_id = userId;
  payload.provider = provider;
  payload.label = "default";

  const { error } = await admin.from("integrations").upsert(payload, {
    onConflict: "user_id,provider,label",
  });
  if (error) throw new Error(`Failed to store ${provider} connection: ${error.message}`);
}

// ---------------------------------------------------------------------------- Google OAuth

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
  "profile",
];

export const GOOGLE_SCOPE_LIST = GOOGLE_SCOPES;

/** Narrow scope set for accounts that only want YouTube (used by the connect flow UI). */
export const GOOGLE_SCOPES_YOUTUBE_ONLY = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
  "openid",
  "email",
  "profile",
];

export const GOOGLE_SCOPES_GMAIL_ONLY = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
  "profile",
];

/**
 * Returns a currently-valid Google access token, transparently refreshing it when it
 * expires within 60 seconds. Throws a typed error the API layer maps to "reconnect".
 */
export async function getGoogleAccessToken(
  admin: SupabaseClient,
  userId: string,
  scopes?: string[]
): Promise<string> {
  const { data, error } = await admin
    .from("oauth_connections")
    .select("access_token_encrypted, refresh_token_encrypted, expires_at, granted_scopes")
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();

  if (error || !data) {
    throw new NotConnectedError("google");
  }

  const refresh = data.refresh_token_encrypted ? unseal(data.refresh_token_encrypted) : null;
  const access = data.access_token_encrypted ? unseal(data.access_token_encrypted) : null;
  const expiresAt = data.expires_at ? new Date(data.expires_at).getTime() : 0;
  const stillFresh = access && expiresAt - Date.now() > 60_000;

  if (stillFresh) {
    if (scopes) assertScopes(data.granted_scopes ?? [], scopes);
    return access!;
  }

  if (!refresh) throw new NotConnectedError("google");

  const e = env();
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured on the server.");
  }

  const body = new URLSearchParams({
    client_id: e.GOOGLE_CLIENT_ID,
    client_secret: e.GOOGLE_CLIENT_SECRET,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  const json = (await response.json()) as GoogleTokenResponse;

  if (!response.ok || !json.access_token) {
    if (json.error === "invalid_grant") {
      throw new NotConnectedError("google");
    }
    throw new Error(
      `Google token refresh failed: ${json.error ?? response.status} ${json.error_description ?? ""}`.trim()
    );
  }

  const newExpiry = Date.now() + (json.expires_in ?? 3500) * 1000;
  const update: Record<string, unknown> = {
    access_token_encrypted: seal(json.access_token),
    expires_at: new Date(newExpiry).toISOString(),
    last_refreshed_at: new Date().toISOString(),
    status: "connected",
  };
  if (json.refresh_token) update.refresh_token_encrypted = seal(json.refresh_token);

  const { error: updateError } = await admin
    .from("oauth_connections")
    .update(update)
    .eq("user_id", userId)
    .eq("provider", "google");
  if (updateError) console.warn("[jarvis] failed to persist refreshed Google token:", updateError.message);

  if (scopes) assertScopes(data.granted_scopes ?? [], scopes);
  return json.access_token;
}

function assertScopes(granted: string[], required: string[]) {
  const missing = required.filter((r) => !granted.some((g) => g === r || g.endsWith(`/${r.split("/").pop()}`)));
  if (missing.length) {
    throw new ScopeError(missing);
  }
}

export class NotConnectedError extends Error {
  constructor(provider: string) {
    super(`${provider} is not connected for this account.`);
    this.name = "NotConnectedError";
  }
}

export class ScopeError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `The connected Google account is missing permission(s): ${missing.join(", ")}. ` +
        `Reconnect Google with the full scope set to enable this action.`
    );
    this.name = "ScopeError";
  }
}
