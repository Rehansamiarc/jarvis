import type { SaveVoiceResult, SessionStatus, VoiceSettings } from "./ipc";

/**
 * Client for the JARVIS brain's existing REST routes.
 *
 * Authentication is the Supabase session cookie captured by the sign-in window: the
 * same credential the browser app uses, replayed verbatim. No API key, no service-role
 * secret and no privileged credential ever reaches this process — if the session is
 * absent the brain simply answers 401, exactly as it does for an anonymous visitor.
 */

export interface BrainOptions {
  /** Origin of the brain, e.g. https://example.freebuff.page */
  baseUrl: string;
  /** Serialized `name=value` cookie header, or "" when signed out. */
  cookieHeader?: string;
  fetchImpl?: typeof fetch;
}

export class BrainError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "BrainError";
  }
}

export function joinUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createBrainClient(options: BrainOptions) {
  const fetchImpl: typeof fetch = options.fetchImpl ?? fetch;
  const cookieHeader = options.cookieHeader ?? "";

  async function call(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (cookieHeader) headers.set("cookie", cookieHeader);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    // Supabase sessions are bearer-grade material: never let a shared cache keep them.
    headers.set("cache-control", "no-store");
    return fetchImpl(joinUrl(options.baseUrl, pathname), { ...init, headers, redirect: "manual" });
  }

  async function readJson(response: Response): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  }

  return {
    /**
     * Probes `GET /api/preferences`, which is authenticated and returns the profile —
     * one request that answers reachability, signed-in state and identity together.
     */
    async session(): Promise<SessionStatus> {
      const base: SessionStatus = {
        signedIn: false,
        email: null,
        brainUrl: options.baseUrl,
        reachable: false,
        detail: "",
      };
      let response: Response;
      try {
        response = await call("/api/preferences");
      } catch (error) {
        return { ...base, detail: `Could not reach the brain: ${(error as Error).message}` };
      }

      const body = await readJson(response);

      if (response.status === 401) {
        return { ...base, reachable: true, detail: "Not signed in. Open the sign-in window to continue." };
      }
      if (response.status === 503) {
        const detail = isRecord(body) && typeof body.error === "string" ? body.error : "not configured";
        return { ...base, reachable: true, detail: `Brain is not configured yet: ${detail}` };
      }
      if (!response.ok) {
        return {
          ...base,
          reachable: true,
          detail: `Brain answered ${response.status} (${isRecord(body) && typeof body.error === "string" ? body.error : "unexpected"})`,
        };
      }

      const profile =
        isRecord(body) && isRecord(body.profile) ? (body.profile as Record<string, unknown>) : null;
      const email = profile && typeof profile.email === "string" ? profile.email : null;
      return { signedIn: true, email, brainUrl: options.baseUrl, reachable: true, detail: "Signed in." };
    },

    async preferences(): Promise<Record<string, unknown> | null> {
      const response = await call("/api/preferences");
      if (!response.ok) throw new BrainError("Could not load preferences.", response.status, "preferences_failed");
      const body = await readJson(response);
      if (!isRecord(body) || !isRecord(body.preferences)) return null;
      return body.preferences;
    },

    async saveVoice(voice: VoiceSettings): Promise<SaveVoiceResult> {
      const response = await call("/api/preferences", {
        method: "PATCH",
        body: JSON.stringify({
          voice_name: voice.name,
          speech_rate: voice.rate,
          speech_pitch: voice.pitch,
          language: voice.language,
        }),
      });

      if (response.status === 401) {
        return { persistedToBrain: false, detail: "Saved locally — sign in to sync this voice with your account." };
      }
      if (!response.ok) {
        const body = await readJson(response);
        const detail = isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
        return { persistedToBrain: false, detail: `Saved locally — the brain rejected the update (${detail}).` };
      }
      return { persistedToBrain: true, detail: "Saved to your JARVIS account." };
    },

    /** Runs one agent turn through the existing controlled tool loop. */
    async runAgent(message: string): Promise<{ reply: string; detail: string }> {
      const response = await call("/api/agent/run", { method: "POST", body: JSON.stringify({ message }) });
      const body = await readJson(response);

      if (response.status === 401) throw new BrainError("Not signed in.", 401, "unauthorized");
      if (!response.ok) {
        const detail = isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
        throw new BrainError(detail, response.status, "agent_failed");
      }

      const reply =
        isRecord(body) && typeof body.reply === "string" && body.reply.trim()
          ? body.reply
          : typeof body === "string" && body.trim()
            ? body
            : "";
      return { reply, detail: reply ? "ok" : "The brain returned no text." };
    },
  };
}

export type BrainClient = ReturnType<typeof createBrainClient>;
