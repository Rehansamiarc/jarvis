import "server-only";
import { env, type Env } from "@/lib/env";
import type { ModelRole } from "./types";

/**
 * Model-provider registry.
 *
 * JARVIS has to be usable without a credit card, so every vendor that can be driven
 * for free is registered here with its endpoint, the environment variable that holds
 * its key, and its default model per role. Adding a vendor is data, not code: the
 * model manager resolves a role to an ordered candidate chain, and this file decides
 * which vendors are reachable at all.
 *
 * Free-tier behaviour, verified against the vendors' own docs in October 2026:
 *
 *  - google  Gemini has a free API tier (model- and project-dependent quota, read the
 *            current values in AI Studio). Chat goes through Google's documented
 *            OpenAI-compatible shim at /v1beta/openai; embeddings have NO
 *            OpenAI-compatible endpoint, so they use the native embedContent call —
 *            which accepts `output_dimensionality`, and 1536 is one of the sizes
 *            Google explicitly recommends, matching our vector(1536) columns.
 *  - groq    Free developer plan with tool-capable models and no request cost.
 *            There is no embeddings endpoint at all, so the embedding role skips it.
 *  - ollama  Runs on this machine: free, unlimited and private. Opt-in only — it is
 *            configured only when OLLAMA_BASE_URL is set, so a laptop without Ollama
 *            is never probed on every request.
 *  - openai  Paid. Kept in the chain so adding a key later needs no code change.
 *
 * Ollama's default for the coding role is `qwen2.5-coder:7b` because it is the model
 * most likely to be already installed for development work; swap it for any model you
 * have pulled (`ollama pull qwen3:8b` for a general-purpose one).
 */

export type ProviderId = "openai" | "google" | "groq" | "ollama";

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  /** Env vars that may hold the key; first non-empty wins. Empty = local server. */
  keyEnvs: string[];
  /** Root of the OpenAI-compatible surface. Ollama is user-configurable. */
  baseUrl: (e: Env) => string;
  /** Default model per role when nothing better is configured in model_config. */
  defaults: Partial<Record<ModelRole, string>>;
  /** Which embedding transport the vendor exposes. */
  embeddings: "openai" | "google" | "ollama" | "none";
  /** Extra request behaviour the OpenAI-compatible transport must respect. */
  tokenParam: "max_completion_tokens" | "none";
  /**
   * Providers that need no key must still be *opted into* by setting this variable,
   * otherwise a machine without the local server would be probed on every request.
   */
  optInEnv?: "OLLAMA_BASE_URL";
  notes: string;
}

export const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GEMINI_NATIVE_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    keyEnvs: ["OPENAI_API_KEY"],
    baseUrl: (e) => e.OPENAI_BASE_URL || "https://api.openai.com/v1",
    defaults: {
      primary: "gpt-5-mini",
      coding: "gpt-5",
      research: "gpt-5",
      summary: "gpt-5-mini",
      vision: "gpt-5-mini",
      speech: "gpt-5-mini",
      embedding: "text-embedding-3-small",
    },
    embeddings: "openai",
    tokenParam: "max_completion_tokens",
    notes: "Paid. Falls back automatically when no key is configured.",
  },
  google: {
    id: "google",
    label: "Google Gemini (free tier)",
    keyEnvs: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    baseUrl: () => GEMINI_OPENAI_BASE,
    /**
     * Measured against the live shim, not copied from a model list. Latency is for a
     * one-line prompt with a 200-token cap:
     *
     *   gemini-3.5-flash-lite   1.9s  answered
     *   gemini-3.1-flash-lite   2.0s  answered
     *   gemini-3.5-flash        4.8s  answered
     *   gemini-3.8-flash       82.0s  finish_reason=length, EMPTY content
     *   gemini-3.7-flash      >100s   timed out
     *   gemini-flash-latest      —    503 overloaded
     *   gemini-2.5-flash         —    404 on the shim (native-only)
     *
     * The Flash-Lite models carry the conversational roles because two seconds is what
     * makes voice mode feel like a conversation at all; the full Flash model takes the
     * roles where reasoning quality is worth the extra three seconds.
     */
    defaults: {
      primary: "gemini-3.5-flash-lite",
      coding: "gemini-3.5-flash",
      research: "gemini-3.5-flash",
      summary: "gemini-3.5-flash-lite",
      vision: "gemini-3.5-flash",
      speech: "gemini-3.5-flash-lite",
      embedding: "gemini-embedding-001",
    },
    embeddings: "google",
    tokenParam: "none",
    notes:
      "Free tier. Unpaid prompts may be reviewed or used to improve Google's models " +
      "(no opt-out on the free tier) — do not route secrets there without checking.",
  },
  groq: {
    id: "groq",
    label: "Groq (free developer plan)",
    keyEnvs: ["GROQ_API_KEY"],
    baseUrl: () => "https://api.groq.com/openai/v1",
    defaults: {
      primary: "qwen/qwen3.8-27b",
      coding: "openai/gpt-oss-120b",
      research: "openai/gpt-oss-120b",
      summary: "qwen/qwen3.8-27b",
      speech: "qwen/qwen3.8-27b",
    },
    embeddings: "none",
    tokenParam: "max_completion_tokens",
    notes:
      "Free developer plan (roughly 30 RPM / 1000 requests a day per model — check " +
      "console.groq.com/docs/rate-limits). No embeddings endpoint.",
  },
  ollama: {
    id: "ollama",
    label: "Ollama (local, free, private)",
    keyEnvs: [],
    optInEnv: "OLLAMA_BASE_URL",
    baseUrl: (e) => e.OLLAMA_BASE_URL || "http://localhost:11434/v1",
    defaults: {
      primary: "qwen3:8b",
      coding: "qwen2.5-coder:7b",
      research: "qwen3:8b",
      summary: "qwen3:8b",
      vision: "gemma3:12b",
      embedding: "nomic-embed-text",
    },
    embeddings: "ollama",
    tokenParam: "none",
    notes:
      "Runs on this machine: no key, no quota, nothing leaves the device. Set " +
      "OLLAMA_BASE_URL to enable it. 8B models want ~8-12 GB of RAM. " +
      "nomic-embed-text is 768-d, so set JARVIS_EMBEDDING_DIM=768 and migrate the " +
      "vector columns before using it for the knowledge base.",
  },
};

export const PROVIDER_ORDER: ProviderId[] = ["openai", "google", "groq", "ollama"];

/** Resolve a provider id from configuration or a database row, with an actionable error. */
export function getProvider(id: string): ProviderPreset {
  const preset = PROVIDER_PRESETS[id as ProviderId];
  if (!preset) {
    throw new Error(
      `Unknown model provider "${id}". Supported: ${PROVIDER_ORDER.join(", ")}. ` +
        `Set it on the model_config row or in .env.local.`
    );
  }
  return preset;
}

export interface ProviderCredentials {
  key: string | null;
  /** Name of the env var to set, when the key is missing. */
  missingVar: string | null;
}

/** Look up the API key for a provider. Local servers (ollama) always resolve. */
export function providerCredentials(id: ProviderId, e: Env = env()): ProviderCredentials {
  const preset = PROVIDER_PRESETS[id];
  if (!preset.keyEnvs.length) return { key: "local", missingVar: null };
  for (const name of preset.keyEnvs) {
    const value = e[name as keyof Env];
    if (typeof value === "string" && value.length > 0) return { key: value, missingVar: null };
  }
  return { key: null, missingVar: preset.keyEnvs[0] };
}

export function isConfigured(id: ProviderId, e: Env = env()): boolean {
  const preset = PROVIDER_PRESETS[id];
  // A key-less local server counts as configured only when its URL is set explicitly.
  if (preset.optInEnv && !e[preset.optInEnv]) return false;
  return providerCredentials(id, e).key !== null;
}

/** Providers reachable right now, in preference order (paid first, free after). */
export function configuredProviders(e: Env = env()): ProviderId[] {
  return PROVIDER_ORDER.filter((id) => isConfigured(id, e));
}

export interface EnvCandidate {
  provider: ProviderId;
  model: string;
}

/**
 * Fallback candidates derived purely from the environment.
 *
 * These are appended after every database-driven candidate so a provider you actually
 * hold a key for is always reachable — a row pointing at OpenAI with no OPENAI_API_KEY
 * set cannot dead-end the request when a free Gemini key exists.
 */
/**
 * Roles a local server can serve with the same downloaded weights, most-preferred first.
 *
 * A hosted vendor answers for any model in its catalogue, but a local server only has
 * the models that were actually pulled — so if the preferred model for a role is not
 * downloaded, the other local defaults are worth trying before giving up.
 */
const LOCAL_ROLE_ORDER: ModelRole[] = ["primary", "coding", "research", "summary", "vision"];

export function envCandidatesFor(role: ModelRole, e: Env = env()): EnvCandidate[] {
  const out: EnvCandidate[] = [];
  for (const id of configuredProviders(e)) {
    const preset = PROVIDER_PRESETS[id];
    if (role === "embedding" && preset.embeddings === "none") continue;
    const model = preset.defaults[role] ?? preset.defaults.primary;
    if (model) out.push({ provider: id, model });

    // Local-only fallback. Never for the embedding role: the chat defaults are not
    // embedding models, and their vector width would not match the vector columns.
    if (preset.id === "ollama" && role !== "embedding") {
      for (const other of LOCAL_ROLE_ORDER) {
        const alt = preset.defaults[other];
        if (alt && alt !== model) out.push({ provider: id, model: alt });
      }
    }
  }
  return out;
}

/** Truthful one-line status for the dashboard: which vendors can answer right now. */
export function aiProviderStatus(e: Env = env()): string[] {
  return configuredProviders(e).map((id) => {
    const p = PROVIDER_PRESETS[id];
    const model = p.defaults.primary ?? p.defaults.embedding ?? "—";
    return `${id} (${p.label}, default ${model})`;
  });
}
