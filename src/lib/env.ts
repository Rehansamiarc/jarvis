import { z } from "zod";

/**
 * Single source of truth for environment variables.
 *
 * Values are read lazily (at call time, not module load) so that `next build` and unit
 * tests can import modules without a fully populated .env.local. `requireEnv()` is for
 * variables that are genuinely mandatory for the call being made, and produces an
 * actionable message instead of an opaque `undefined`.
 */

const EnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  SECRET_ENCRYPTION_KEY: z.string().min(16).optional(),
  CRON_SECRET: z.string().min(8).optional(),

  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().url().optional(),

  // Free-tier model providers. Any one of these is enough to run JARVIS at zero cost.
  // https://aistudio.google.com/apikey (Gemini free tier, also accepted as GEMINI_API_KEY)
  GOOGLE_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  // https://console.groq.com/keys (free developer plan)
  GROQ_API_KEY: z.string().min(1).optional(),
  // Local Ollama server. Set to enable it — it is never probed when unset.
  OLLAMA_BASE_URL: z.string().url().optional(),
  JARVIS_MODEL_PRIMARY: z.string().min(1).optional(),
  JARVIS_MODEL_CODING: z.string().min(1).optional(),
  JARVIS_MODEL_RESEARCH: z.string().min(1).optional(),
  JARVIS_MODEL_SUMMARY: z.string().min(1).optional(),
  JARVIS_MODEL_VISION: z.string().min(1).optional(),
  JARVIS_MODEL_SPEECH: z.string().min(1).optional(),
  JARVIS_EMBEDDING_MODEL: z.string().min(1).optional(),
  JARVIS_EMBEDDING_DIM: z.coerce.number().int().positive().optional(),

  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_HOSTED_DOMAIN: z.string().min(1).optional(),

  WORDPRESS_SITE_URL: z.string().url().optional(),
  WORDPRESS_USERNAME: z.string().min(1).optional(),
  WORDPRESS_APP_PASSWORD: z.string().min(1).optional(),

  SERPER_API_KEY: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM: z.string().min(1).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Normalise a Supabase project URL.
 *
 * The dashboard puts the project URL and the REST endpoint side by side, and copying
 * the REST one (`https://<ref>.supabase.co/rest/v1/`) is an easy mistake with a silent,
 * total effect: supabase-js appends its own `/rest/v1` and `/auth/v1` segments, so every
 * call becomes `/rest/v1/rest/v1/...` and answers `404 PGRST125 Invalid path specified`,
 * while the health endpoint still reports Supabase as configured. Strip exactly the
 * API suffix and keep anything else — a self-hosted project may legitimately live under
 * a subpath.
 */
export function normalizeSupabaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(rest|auth)\/v1$/i, "");
}

let cached: Env | null = null;

/** Drop the memoised snapshot. Used by tests that vary the environment per case. */
export function resetEnvCache(): void {
  cached = null;
}

export function env(): Env {
  if (cached) return cached;

  const shape = EnvSchema.shape;
  const result: Record<string, unknown> = {};
  const issues: string[] = [];

  // Parse field by field, and treat an empty value as unset. Anything else silently
  // disabled *every* feature: one blank optional variable (RESEND_FROM="") failed the
  // whole-object parse, and `env()` fell back to an empty object — so a harmless
  // setting turned off AI, Supabase and OAuth together.
  for (const [key, value] of Object.entries(process.env)) {
    const field = shape[key as keyof typeof shape];
    if (!field || value === undefined) continue;
    if (value.trim() === "") continue;

    const parsed = field.safeParse(value);
    if (parsed.success) result[key] = parsed.data;
    else issues.push(`${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }

  if (issues.length) {
    // Never throw at import time — an incomplete env should degrade the specific
    // feature, not prevent the application from booting or building.
    console.warn(`[jarvis] ignoring invalid environment variables: ${issues.join("; ")}`);
  }

  const configuredUrl = result.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
  if (configuredUrl) {
    const normalized = normalizeSupabaseUrl(configuredUrl);
    if (normalized !== configuredUrl) {
      result.NEXT_PUBLIC_SUPABASE_URL = normalized;
      console.warn(
        `[jarvis] NEXT_PUBLIC_SUPABASE_URL pointed at the REST endpoint ` +
          `("${configuredUrl}"); using "${normalized}" instead. Copy the project URL ` +
          `from Project Settings → API, not the REST endpoint.`
      );
    }
  }

  cached = result as Env;
  return cached;
}

/** Normalised app origin with no trailing slash. */
export function appUrl(): string {
  const raw =
    env().NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    "http://localhost:3000";
  return raw.replace(/\/$/, "");
}

export class MissingEnvError extends Error {
  constructor(keys: string[], feature: string) {
    super(
      `${feature} is not configured. Missing environment variable${keys.length > 1 ? "s" : ""}: ` +
        `${keys.join(", ")}. Set ${keys.length > 1 ? "them" : "it"} in .env.local (local) or ` +
        `Vercel → Settings → Environment Variables (production), then redeploy. ` +
        `See .env.example and README.md.`
    );
    this.name = "MissingEnvError";
  }
}

export function requireEnv<K extends keyof Env>(...keys: K[]): Pick<Env, K> {
  const e = env();
  const missing = keys.filter((k) => !e[k]) as K[];
  if (missing.length) throw new MissingEnvError(missing as string[], "This feature");
  return e as Pick<Env, K>;
}

/** Feature-detection helpers so the UI can truthfully show what is and isn't connected. */
export const availability = () => ({
  supabase: Boolean(env().NEXT_PUBLIC_SUPABASE_URL && env().NEXT_PUBLIC_SUPABASE_ANON_KEY),
  // Any reachable model provider counts as "AI configured" — including the free tiers
  // and a local Ollama server, which need no paid key at all.
  ai: Boolean(env().OPENAI_API_KEY || env().GOOGLE_API_KEY || env().GEMINI_API_KEY || env().GROQ_API_KEY || env().OLLAMA_BASE_URL),
  google: Boolean(env().GOOGLE_CLIENT_ID && env().GOOGLE_CLIENT_SECRET),
  wordpressStatic:
    Boolean(env().WORDPRESS_SITE_URL && env().WORDPRESS_USERNAME && env().WORDPRESS_APP_PASSWORD),
  serper: Boolean(env().SERPER_API_KEY),
  resend: Boolean(env().RESEND_API_KEY),
  encryption: Boolean(env().SECRET_ENCRYPTION_KEY),
});
