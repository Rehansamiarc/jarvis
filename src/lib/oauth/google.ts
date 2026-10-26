import "server-only";

/** Shared Google OAuth constants — route files may only export HTTP handlers. */

export const GOOGLE_OAUTH_COOKIE = "jarvis_oauth_state";

export interface GoogleProfile {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  hd?: string;
}

export async function fetchGoogleProfile(
  accessToken: string
): Promise<GoogleProfile | null> {
  try {
    const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as GoogleProfile;
    return json?.sub ? json : null;
  } catch {
    return null;
  }
}

/** True when a granted-scope list contains the given scope (by exact match or tail). */
export function hasScope(granted: string[], scope: string): boolean {
  return granted.some((g) => g === scope || g.endsWith(scope));
}
