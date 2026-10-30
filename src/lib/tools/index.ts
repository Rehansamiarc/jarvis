import "server-only";
import { registry } from "./registry";
import { registerCoreTools } from "./definitions/core";
import { registerWorkTools } from "./definitions/work";
import { registerWordPressTools } from "./definitions/wordpress";
import { registerYouTubeTools } from "./definitions/youtube";
import { registerMessagingTools } from "./definitions/messaging";

/**
 * Module-evaluation epoch. A dev hot reload re-executes this module, which yields a new
 * epoch, while `globalThis` still holds the previous registry — so the registry is
 * rebuilt (picking up edited handlers) instead of being appended to (which threw
 * "Duplicate tool registration: load_tools" on the next request).
 */
const EPOCH = {};
const INIT_KEY = Symbol.for("jarvis.toolsInitEpoch");
const globalStore = globalThis as typeof globalThis & { [INIT_KEY]?: unknown };

/**
 * Idempotent registration. Every capability in JARVIS is registered exactly once here;
 * `registry.register` throws on duplicates, so a genuine double registration surfaces
 * immediately rather than as two subtly different handlers for the same tool name.
 */
export function initTools(): typeof registry {
  if (globalStore[INIT_KEY] !== EPOCH) {
    registry.clear();
    registerCoreTools();
    registerWorkTools();
    registerWordPressTools();
    registerYouTubeTools();
    registerMessagingTools();
    globalStore[INIT_KEY] = EPOCH;
  }
  return registry;
}

export { registry };
export type { ToolContext, ToolDefinition, ToolResult } from "./registry";
export { selectTools, loadTools } from "./select";
