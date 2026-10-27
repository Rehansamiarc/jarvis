import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env, type Env } from "@/lib/env";
import { createOpenAIProvider, ProviderError, ProviderUnavailableError } from "./provider-openai";
import { createGoogleProvider } from "./provider-google";
import { createOllamaProvider } from "./provider-ollama";
import {
  envCandidatesFor,
  getProvider,
  providerCredentials,
  type ProviderId,
} from "./providers";
import type { ModelProvider, ModelRole, ResolvedModel } from "./types";
import { inferCapabilities } from "./types";

/**
 * Model manager (section F-A).
 *
 * Responsibilities:
 *  - resolve a *role* (primary / coding / research / summary / vision / speech / embedding)
 *    to a concrete model, preferring a per-account override in `model_config`, then the
 *    platform default row, then environment configuration.
 *  - route each role to a provider while guaranteeing a fallback model when one is
 *    unavailable, rate-limited, or lacks the capability the call needs.
 *  - refuse, rather than assume, when a model does not support a modality.
 */

const ENV_MODEL: Record<ModelRole, (e: Env) => string | undefined> = {
  primary: (e) => e.JARVIS_MODEL_PRIMARY,
  coding: (e) => e.JARVIS_MODEL_CODING,
  research: (e) => e.JARVIS_MODEL_RESEARCH,
  summary: (e) => e.JARVIS_MODEL_SUMMARY,
  vision: (e) => e.JARVIS_MODEL_VISION,
  speech: (e) => e.JARVIS_MODEL_SPEECH,
  embedding: (e) => e.JARVIS_EMBEDDING_MODEL,
};

const BUILT_IN_DEFAULT: Record<ModelRole, string> = {
  primary: "gpt-5-mini",
  coding: "gpt-5",
  research: "gpt-5",
  summary: "gpt-5-mini",
  vision: "gpt-5-mini",
  speech: "gpt-5-mini",
  embedding: "text-embedding-3-small",
};

interface ConfigRow {
  provider: string;
  model: string;
  base_url: string | null;
  fallback_order: number;
  max_output_tokens: number | null;
  temperature: number | null;
}

// Platform defaults rarely change; cache them briefly so a chat turn costs one query,
// not one per role lookup. User overrides are always read fresh (they are few and cheap).
let globalConfigCache: { rows: ConfigRow[]; at: number } | null = null;
const GLOBAL_TTL_MS = 60_000;

/** Forget cached platform defaults — used after config writes and by tests. */
export function invalidateModelConfigCache(): void {
  globalConfigCache = null;
}

async function loadConfigRows(
  client: SupabaseClient,
  userId: string | null
): Promise<{ userRows: ConfigRow[]; globalRows: ConfigRow[] }> {
  const now = Date.now();
  let globalRows: ConfigRow[];

  if (globalConfigCache && now - globalConfigCache.at < GLOBAL_TTL_MS) {
    globalRows = globalConfigCache.rows;
  } else {
    const { data, error } = await client
      .from("model_config")
      .select("provider, model, base_url, fallback_order, max_output_tokens, temperature")
      .is("user_id", null)
      .order("fallback_order", { ascending: true });
    if (error) {
      globalRows = [];
    } else {
      globalRows = (data ?? []) as ConfigRow[];
      globalConfigCache = { rows: globalRows, at: now };
    }
  }

  let userRows: ConfigRow[] = [];
  if (userId) {
    const { data } = await client
      .from("model_config")
      .select("provider, model, base_url, fallback_order, max_output_tokens, temperature, role")
      .eq("user_id", userId);
    userRows = (data ?? []) as (ConfigRow & { role: string })[];
  }

  return { userRows, globalRows };
}

export interface ResolvedModelFull extends ResolvedModel {
  maxOutputTokens?: number;
  temperature?: number;
}

/** Ordered candidate list for a role: role-specific first, then the primary model. */
export async function resolveModelChain(
  client: SupabaseClient,
  role: ModelRole,
  userId: string | null
): Promise<ResolvedModelFull[]> {
  const e = env();
  const { userRows, globalRows } = await loadConfigRows(client, userId);
  const byRole = (rows: Array<ConfigRow & { role?: string }>, r: ModelRole) =>
    rows.find((row) => (row as { role?: string }).role === r);

  const candidates: ResolvedModelFull[] = [];
  const seen = new Set<string>();

  const push = (candidate: RowCandidate, fallbackRole: ModelRole) => {
    const model =
      candidate.model || ENV_MODEL[fallbackRole](e) || BUILT_IN_DEFAULT[fallbackRole];
    const provider = inferProvider(model, candidate.provider);
    const baseUrl =
      candidate.baseUrl ?? (fallbackRole === "embedding" ? undefined : e.OPENAI_BASE_URL);
    const key = `${provider}:${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      provider,
      model,
      baseUrl,
      role: fallbackRole,
      capabilities: inferCapabilities(model),
      maxOutputTokens: candidate.maxOutputTokens,
      temperature: candidate.temperature,
    });
  };

  const fromRow = (row: ConfigRow | undefined): RowCandidate => ({
    provider: row?.provider,
    model: row?.model,
    baseUrl: row?.base_url ?? undefined,
    maxOutputTokens: row?.max_output_tokens ?? undefined,
    temperature: row?.temperature ?? undefined,
  });

  const userRow = byRole(userRows, role);
  const globalRow = byRole(globalRows, role);
  push(fromRow(userRow ?? globalRow), role);

  // Fallbacks: other rows for this role (by fallback_order), then the primary model.
  if (role !== "primary") {
    const fallbacks = [...userRows, ...globalRows]
      .filter((r) => (r as { role?: string }).role === "primary")
      .sort((a, b) => a.fallback_order - b.fallback_order);
    for (const row of fallbacks) push(fromRow(row), "primary");
  }

  // Environment-configured providers (free tiers, local Ollama) are always appended so
  // a key you actually hold stays reachable even when the database rows point at a
  // vendor you have not configured — a row for OpenAI with no OPENAI_API_KEY set must
  // not dead-end the request when a free Gemini key exists.
  for (const candidate of envCandidatesFor(role, e)) {
    push({ provider: candidate.provider, model: candidate.model }, role);
  }

  if (candidates.length === 0) push(fromRow(undefined), "primary");
  return candidates;
}

export async function resolveModel(
  client: SupabaseClient,
  role: ModelRole,
  userId: string | null
): Promise<ResolvedModelFull> {
  const chain = await resolveModelChain(client, role, userId);
  return chain[0];
}

export interface FallbackOptions {
  /** When true, skip candidates whose model lacks tool support. */
  needTools?: boolean;
  /** When true, skip candidates without structured-output support. */
  needJson?: boolean;
  needVision?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Execute `fn` against the first candidate that is capable and healthy.
 *
 * Falls through to the next candidate when the provider is unavailable/rate-limited, or
 * when the error clearly indicates a capability mismatch (the model does not implement
 * tool calling, vision, or structured output). Genuine request errors are rethrown so
 * the caller sees the real problem instead of a misleading fallback failure.
 */
export async function withModelFallback<T>(
  client: SupabaseClient,
  role: ModelRole,
  userId: string | null,
  fn: (provider: ModelProvider, model: ResolvedModelFull) => Promise<T>,
  options: FallbackOptions = {}
): Promise<T> {
  const chain = await resolveModelChain(client, role, userId);
  const errors: string[] = [];

  for (const candidate of chain) {
    if (options.needTools && !candidate.capabilities.tools) {
      errors.push(`${candidate.model}: no tool support`);
      continue;
    }
    if (options.needJson && !candidate.capabilities.json) {
      errors.push(`${candidate.model}: no structured output support`);
      continue;
    }
    if (options.needVision && !candidate.capabilities.vision) {
      errors.push(`${candidate.model}: no vision support`);
      continue;
    }

    let provider: ModelProvider;
    try {
      provider = buildProvider(candidate);
    } catch (error) {
      errors.push(`${candidate.model}: ${(error as Error).message}`);
      continue;
    }

    try {
      return await fn(provider, candidate);
    } catch (error) {
      const message = (error as Error).message;
      const looksLikeCapability = /tool|function calling|not support|unsupported|modality|image input/i.test(
        message
      );
      const isTransient = error instanceof ProviderError && error.retryable;
      const isUnavailable = error instanceof ProviderUnavailableError;

      // A provider that does not have the selected model is a candidate-level problem,
      // not a request-level one: the next candidate can still answer. Verified against
      // Ollama, which answers 404 for a model that was never pulled, and against
      // OpenAI-compatible vendors, which answer 404 with "model does not exist".
      const missingModel =
        (error instanceof ProviderError && error.status === 404) ||
        /model_not_found|not_found_error|no such model|\bmodel\b[^.]{0,200}?\b(not found|does not exist)\b/i.test(
          message
        );

      if ((isTransient || isUnavailable || looksLikeCapability || missingModel) && chain.length > 1) {
        errors.push(`${candidate.model}: ${message}`);
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `No available model satisfied this request. Tried ${chain.length} candidate(s): ${errors.join("; ")}`
  );
}

interface RowCandidate {
  provider?: string;
  model?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  temperature?: number;
}

/**
 * Work out which vendor owns a model name.
 *
 * Rows carry a provider column, but the environment overrides and the built-in
 * defaults do not, so a model like `gemini-3.8-flash` must not be sent to OpenAI's
 * endpoint just because the row defaulted to "openai". Only unambiguous families are
 * inferred; anything else keeps the configured provider.
 */
function inferProvider(model: string, explicit: string | undefined): string {
  if (explicit && explicit !== "openai") return explicit;
  if (/^gemini-/i.test(model)) return "google";
  if (/(?:^|\/)gpt-oss-|^qwen\//i.test(model)) return "groq";
  // Ollama tags its local models with a colon: qwen3:8b, llama3.1:8b, nomic-embed-text.
  if (/^[a-z0-9._-]+:[a-z0-9._-]+$/i.test(model)) return "ollama";
  return explicit ?? "openai";
}

function buildProvider(model: ResolvedModelFull): ModelProvider {
  const e = env();
  const preset = getProvider(model.provider);
  const { key, missingVar } = providerCredentials(preset.id as ProviderId, e);
  if (!key) {
    throw new MissingKeyError(missingVar!, preset.label);
  }

  switch (preset.id) {
    case "google":
      return createGoogleProvider({
        apiKey: key,
        baseUrl: model.baseUrl ?? preset.baseUrl(e),
        capabilities: model.capabilities,
      });
    case "ollama":
      return createOllamaProvider({
        baseUrl: model.baseUrl ?? preset.baseUrl(e),
        capabilities: model.capabilities,
      });
    default:
      return createOpenAIProvider({
        id: preset.id,
        apiKey: key,
        baseUrl: model.baseUrl ?? preset.baseUrl(e),
        capabilities: model.capabilities,
        tokenParam: preset.tokenParam,
      });
  }
}

class MissingKeyError extends Error {
  constructor(variable: string, label: string) {
    super(
      `${variable} is not configured — set it in .env.local (or Vercel → Settings → ` +
        `Environment Variables) to use ${label}. See .env.example for every free option.`
    );
    this.name = "MissingKeyError";
  }
}

export { ProviderError, ProviderUnavailableError };
