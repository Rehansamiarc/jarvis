import "server-only";
import { z, toJSONSchema } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolSpec } from "@/lib/ai/types";
import type { PermissionMode, RiskLevel } from "@/lib/permissions/policy";

/**
 * Tool registry (section F-B).
 *
 * Every callable capability lives here exactly once: name, description, a Zod input
 * schema (which doubles as the JSON Schema handed to the model), its risk class, the
 * connection it needs, and its handler.
 *
 * The server — never the model — decides whether a tool exists, whether it may run, and
 * what its arguments must look like.
 */

export type IntegrationName =
  | "wordpress"
  | "youtube"
  | "gmail"
  | "serper"
  | "resend"
  | "webhook";

export interface ToolContext {
  userId: string;
  /** Row-Level-Security scoped client: queries are automatically limited to this user. */
  db: SupabaseClient;
  /**
   * Service-role client, present only when SUPABASE_SERVICE_ROLE_KEY is configured.
   * Needed solely to read encrypted credential columns (which are deliberately not
   * grantable to a client session) and to refresh OAuth tokens. Every call through it
   * MUST filter by `userId`.
   */
  admin: SupabaseClient | null;
  conversationId?: string | null;
  permissionMode: PermissionMode;
  connections: Record<string, string>;
  runId: string;
  signal?: AbortSignal;
  /** Registered by the `load_tools` tool so later steps can see newly available tools. */
  onToolsLoaded?: (names: string[]) => void;
}

export interface ToolResult {
  ok: boolean;
  /** Structured payload rendered back to the model and stored in execution_logs. */
  data?: unknown;
  error?: string;
  /**
   * True only when the handler confirmed the effect against the provider (for example
   * re-fetched the created post). `ok` alone never proves an external change happened.
   */
  verified?: boolean;
}

export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  category: string;
  risk: RiskLevel;
  requiresConnection?: IntegrationName;
  /** Alternative providers — satisfied when at least one is connected (e.g. Gmail OR Resend). */
  requiresAnyConnection?: IntegrationName[];
  requiresApproval?: boolean;
  /** Keywords used by the router to decide whether this tool is relevant to a request. */
  triggers?: string[];
  schema: TSchema;
  /**
   * Builds the exact, action-specific payload shown in the confirmation dialog. Runs on
   * the server with real data (e.g. it fetches the draft from Gmail) so the user
   * approves what will actually happen rather than a model-authored paraphrase.
   */
  preview?: (args: z.infer<TSchema>, ctx: ToolContext) => Promise<Record<string, unknown>>;
  execute: (args: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolResult>;
}

type AnyTool = ToolDefinition<z.ZodTypeAny>;

/**
 * Identity helper that preserves the concrete schema type so handlers receive strongly
 * typed arguments (a bare `const x: ToolDefinition = ...` would widen them to unknown).
 */
export function defineTool<TSchema extends z.ZodTypeAny>(tool: ToolDefinition<TSchema>): ToolDefinition<TSchema> {
  return tool;
}

class ToolRegistry {
  private tools = new Map<string, AnyTool>();

  register(tool: AnyTool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: AnyTool[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Drops every registration. Used when a module is re-evaluated (dev HMR). */
  clear(): this {
    this.tools.clear();
    return this;
  }

  /** JSON Schema for the model. Generated from the same Zod schema that validates input. */
  spec(tool: AnyTool): ToolSpec {
    const json = toJSONSchema(tool.schema, { target: "draft-2020-12", io: "input" }) as Record<
      string,
      unknown
    >;
    delete json.$schema;
    json.type = "object";
    return { name: tool.name, description: tool.description, parameters: json };
  }

  specs(names: string[]): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const n of names) {
      const t = this.tools.get(n);
      if (t) out.push(this.spec(t));
    }
    return out;
  }

  /** Runtime validation of model-supplied arguments. Throws with a precise path. */
  validate(name: string, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool "${name}"` };

    let parsedInput: unknown = raw;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) parsedInput = {};
      else {
        try {
          parsedInput = JSON.parse(trimmed);
        } catch (e) {
          return { ok: false, error: `Tool arguments for "${name}" are not valid JSON: ${(e as Error).message}` };
        }
      }
    }

    const result = tool.schema.safeParse(parsedInput);
    if (!result.success) {
      const detail = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return { ok: false, error: `Invalid arguments for "${name}": ${detail}` };
    }
    return { ok: true, value: result.data };
  }
}

/**
 * The registry is a process-wide singleton, but Next re-evaluates modules on a dev hot
 * reload while the module graph keeps the old instance alive. Caching it on `globalThis`
 * (plus the epoch check in `initTools`) keeps one registry and avoids
 * "Duplicate tool registration" after an edit.
 */
const REGISTRY_KEY = Symbol.for("jarvis.toolRegistry");
const globalStore = globalThis as typeof globalThis & { [REGISTRY_KEY]?: ToolRegistry };

export const registry: ToolRegistry = (globalStore[REGISTRY_KEY] ??= new ToolRegistry());
