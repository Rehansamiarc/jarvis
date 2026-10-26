import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env, type Env } from "@/lib/env";
import { createOpenAIProvider, ProviderError, ProviderUnavailableError } from "./provider-openai";
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

  const push = (row: (ConfigRow & { role?: string }) | undefined, fallbackRole: ModelRole) => {
    const model = row?.model || ENV_MODEL[fallbackRole](e) || BUILT_IN_DEFAULT[fallbackRole];
    const provider = row?.provider ?? "openai";
    const baseUrl = row?.base_url ?? (fallbackRole === "embedding" ? undefined : e.OPENAI_BASE_URL);
    const key = `${provider}:${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      provider,
      model,
      baseUrl,
      role: fallbackRole,
      capabilities: inferCapabilities(model),
      maxOutputTokens: row?.max_output_tokens ?? undefined,
      temperature: row?.temperature ?? undefined,
    });
  };

  const userRow = byRole(userRows, role);
  const globalRow = byRole(globalRows, role);
  push(userRow ?? globalRow, role);

  // Fallbacks: other rows for this role (by fallback_order), then the primary model.
  if (role !== "primary") {
    const fallbacks = [...userRows, ...globalRows]
      .filter((r) => (r as { role?: string }).role === "primary")
      .sort((a, b) => a.fallback_order - b.fallback_order);
    for (const row of fallbacks) push(row, "primary");
  }

  if (candidates.length === 0) push(undefined, "primary");
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

      if ((isTransient || isUnavailable || looksLikeCapability) && chain.length > 1) {
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

function buildProvider(model: ResolvedModelFull): ModelProvider {
  const e = env();
  if (!e.OPENAI_API_KEY) throw new MissingKeyError();
  if (model.provider !== "openai") {
    throw new Error(`Provider "${model.provider}" is not implemented — supported: openai-compatible`);
  }
  return createOpenAIProvider({
    apiKey: e.OPENAI_API_KEY,
    baseUrl: model.baseUrl ?? e.OPENAI_BASE_URL,
    capabilities: model.capabilities,
  });
}

class MissingKeyError extends Error {
  constructor() {
    super("OPENAI_API_KEY is not configured");
    this.name = "MissingKeyError";
  }
}

export { ProviderError, ProviderUnavailableError };
