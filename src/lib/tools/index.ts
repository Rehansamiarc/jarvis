import "server-only";
import { registry } from "./registry";
import { registerCoreTools } from "./definitions/core";
import { registerWorkTools } from "./definitions/work";
import { registerWordPressTools } from "./definitions/wordpress";
import { registerYouTubeTools } from "./definitions/youtube";
import { registerMessagingTools } from "./definitions/messaging";

let registered = false;

/**
 * Idempotent registration. Every capability in JARVIS is registered exactly once here;
 * `registry.register` throws on duplicates, so a double call surfaces as a build error
 * rather than two subtly different handlers for the same tool name.
 */
export function initTools(): typeof registry {
  if (!registered) {
    registerCoreTools();
    registerWorkTools();
    registerWordPressTools();
    registerYouTubeTools();
    registerMessagingTools();
    registered = true;
  }
  return registry;
}

export { registry };
export type { ToolContext, ToolDefinition, ToolResult } from "./registry";
export { selectTools, loadTools } from "./select";
