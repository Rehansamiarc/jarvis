import "server-only";
import type { PermissionMode } from "@/lib/permissions/policy";
import { registry } from "./registry";

/**
 * Task-driven tool loading (section F-B).
 *
 * Shipping 25 tool schemas on every request costs tokens, dilutes attention, and hands
 * the model capabilities it has no use for. So we send only the tools that are:
 *
 *   1. permitted by the account's permission mode,
 *   2. plausibly relevant to this request (intent routing),
 *   3. within a per-request budget.
 *
 * Everything else is *deferred*: the model is told the tool exists, and can ask for it
 * by name through the `load_tools` tool. Unavailable connections are advertised in the
 * system prompt rather than as runnable tools, so JARVIS never implies access it lacks.
 */

export interface DeferredTool {
  name: string;
  description: string;
}

export interface ToolSelection {
  loaded: string[];
  deferred: DeferredTool[];
}

const DEFAULT_BUDGET = 14;

/** Always available — cheap, safe, and needed in almost every conversation. */
const CORE = [
  "load_tools",
  "memory.search",
  "memory.save",
  "knowledge.search",
  "notes.create",
  "task.create",
  "task.update",
  "reminder.create",
  "reminder.list",
  "notify",
  "web_search",
];

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
  );
}

function matchesIntent(triggers: string[] | undefined, tokens: Set<string>, raw: string): boolean {
  if (!triggers?.length) return false;
  const haystack = raw.toLowerCase();
  return triggers.some((t) => {
    const needle = t.toLowerCase();
    if (needle.includes(" ")) return haystack.includes(needle);
    return tokens.has(needle);
  });
}

export function selectTools(options: {
  mode: PermissionMode;
  connections: Record<string, string>;
  intent: string;
  budget?: number;
}): ToolSelection {
  const { mode, connections, intent } = options;
  const budget = options.budget ?? DEFAULT_BUDGET;
  const tokens = tokenize(intent);

  const loaded = new Set<string>();
  const deferred: DeferredTool[] = [];

  const usable = (name: string): boolean => {
    const tool = registry.get(name);
    if (!tool) return false;
    // Read-only mode never exposes mutation tools at all — not even behind a prompt.
    if (mode === "read_only" && tool.risk !== "read") return false;
    return true;
  };

  for (const name of CORE) {
    if (loaded.has(name) || !usable(name)) continue;
    if (name === "load_tools") {
      loaded.add(name);
      continue;
    }
    // Core tools are cheap; load them outright when relevant or always-safe to offer.
    const tool = registry.get(name)!;
    if (tool.risk === "read" || matchesIntent(tool.triggers, tokens, intent)) {
      loaded.add(name);
    } else {
      deferred.push({ name, description: tool.description });
    }
  }

  // Integration + specialist tools: load on explicit intent match, otherwise defer.
  const rest = registry
    .list()
    .filter((t) => !loaded.has(t.name) && usable(t.name))
    .sort((a, b) => {
      const aHit = matchesIntent(a.triggers, tokens, intent) ? 0 : 1;
      const bHit = matchesIntent(b.triggers, tokens, intent) ? 0 : 1;
      if (aHit !== bHit) return aHit - bHit;
      // Reads before writes when nothing else separates them.
      const order = { read: 0, write: 1, high: 2 } as const;
      return order[a.risk] - order[b.risk];
    });

  for (const tool of rest) {
    const relevant = matchesIntent(tool.triggers, tokens, intent);
    const connected =
      (!tool.requiresConnection || connections[tool.requiresConnection] === "connected") &&
      (!tool.requiresAnyConnection?.length ||
        tool.requiresAnyConnection.some((p) => connections[p] === "connected"));

    if (relevant && connected && loaded.size < budget) {
      loaded.add(tool.name);
    } else {
      deferred.push({ name: tool.name, description: tool.description });
    }
  }

  return { loaded: [...loaded], deferred };
}

/**
 * Resolve a `load_tools` request. Returns the names that actually became available and
 * an explanation for each that did not, so the model reports limitations truthfully.
 */
export function loadTools(
  names: string[],
  options: { mode: PermissionMode; connections: Record<string, string> }
): { available: string[]; unavailable: Array<{ name: string; reason: string }> } {
  const available: string[] = [];
  const unavailable: Array<{ name: string; reason: string }> = [];

  for (const raw of names.slice(0, 20)) {
    const name = raw.trim();
    const tool = registry.get(name);
    if (!tool) {
      unavailable.push({ name, reason: "No such tool exists in JARVIS." });
      continue;
    }
    if (options.mode === "read_only" && tool.risk !== "read") {
      unavailable.push({
        name,
        reason: "Blocked: permission mode is Read-only.",
      });
      continue;
    }
    if (tool.requiresConnection && options.connections[tool.requiresConnection] !== "connected") {
      unavailable.push({
        name,
        reason: `Requires a ${tool.requiresConnection} connection that is not authorised for this account.`,
      });
      continue;
    }
    if (
      tool.requiresAnyConnection?.length &&
      !tool.requiresAnyConnection.some((p) => options.connections[p] === "connected")
    ) {
      unavailable.push({
        name,
        reason: `Requires one of: ${tool.requiresAnyConnection.join(", ")} — none are connected.`,
      });
      continue;
    }
    available.push(name);
  }

  return { available, unavailable };
}
