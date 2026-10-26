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

let cached: Env | null = null;

/** Drop the memoised snapshot. Used by tests that vary the environment per case. */
export function resetEnvCache(): void {
  cached = null;
}

export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  // Never throw at import time — an incomplete env should degrade the specific feature,
  // not prevent the application from booting or building.
  cached = parsed.success ? parsed.data : ({} as Env);
  if (!parsed.success) {
    console.warn("[jarvis] some environment variables failed validation", parsed.error.issues);
  }
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
  ai: Boolean(env().OPENAI_API_KEY),
  google: Boolean(env().GOOGLE_CLIENT_ID && env().GOOGLE_CLIENT_SECRET),
  wordpressStatic:
    Boolean(env().WORDPRESS_SITE_URL && env().WORDPRESS_USERNAME && env().WORDPRESS_APP_PASSWORD),
  serper: Boolean(env().SERPER_API_KEY),
  resend: Boolean(env().RESEND_API_KEY),
  encryption: Boolean(env().SECRET_ENCRYPTION_KEY),
});
