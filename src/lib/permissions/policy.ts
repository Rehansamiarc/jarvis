import "server-only";

/**
 * Permission engine (section 13).
 *
 * This is deliberately independent of the model. The agent asks; this decides. Nothing
 * here reads model output, so no prompt-injection can widen what JARVIS is allowed to do.
 *
 *   read     -> always allowed once the underlying connection is authorised
 *   write    -> reversible side effects (create draft, save memory, schedule reminder)
 *   high     -> consequential: publish, send, delete, upload, change settings
 */

export type RiskLevel = "read" | "write" | "high";

export type PermissionMode =
  | "read_only"
  | "auto_low_risk"
  | "auto_approved"
  | "ask_everything";

export interface PolicyInput {
  mode: PermissionMode;
  risk: RiskLevel;
  /** Tool metadata: some write actions are individually flagged as requiring approval. */
  toolRequiresApproval?: boolean;
  /** Provider the tool needs, e.g. "wordpress". Null/undefined means no connection needed. */
  requiresConnection?: string | null;
  /** Alternative providers — satisfied when at least one is connected. */
  requiresAnyConnection?: string[];
  /** Map of provider -> integration status for this account. */
  connections: Record<string, string>;
}

export interface PolicyDecision {
  allowed: boolean;
  /** True when the action may run now but only after an explicit user confirmation. */
  requiresApproval: boolean;
  reason: string;
  code: "ok" | "read_only" | "not_connected" | "needs_confirmation" | "denied";
}

const CONNECTION_LABELS: Record<string, string> = {
  wordpress: "WordPress",
  youtube: "YouTube",
  gmail: "Gmail",
  serper: "Web search",
  resend: "Email (Resend)",
};

export function connectionLabel(provider: string): string {
  return CONNECTION_LABELS[provider] ?? provider;
}

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { mode, risk, toolRequiresApproval, requiresConnection, requiresAnyConnection, connections } = input;

  if (requiresConnection || requiresAnyConnection?.length) {
    const needed = requiresConnection ? [requiresConnection] : (requiresAnyConnection ?? []);
    const satisfied = needed.find((p) => connections[p] === "connected");
    if (!satisfied) {
      const labels = needed.map(connectionLabel).join(" or ");
      return {
        allowed: false,
        requiresApproval: false,
        code: "not_connected",
        reason:
          `${labels} ${needed.length > 1 ? "are" : "is"} not connected for this account` +
          `. Connect ${needed.length > 1 ? "one of them" : "it"} in Settings → Connected accounts before using this tool.`,
      };
    }
  }

  if (risk === "read") {
    return { allowed: true, requiresApproval: false, code: "ok", reason: "Read-only action" };
  }

  if (mode === "read_only") {
    return {
      allowed: false,
      requiresApproval: false,
      code: "read_only",
      reason:
        "Permission mode is Read-only, so JARVIS may not make any change. " +
        "Switch the mode in Settings → Permissions to allow this.",
    };
  }

  const needsApproval = risk === "high" || toolRequiresApproval === true;

  if (mode === "ask_everything") {
    return {
      allowed: true,
      requiresApproval: true,
      code: "needs_confirmation",
      reason: "Permission mode is Ask-anything, so every change needs your confirmation.",
    };
  }

  if (needsApproval) {
    return {
      allowed: true,
      requiresApproval: true,
      code: "needs_confirmation",
      reason:
        risk === "high"
          ? "This is a consequential action (publish, send, delete or spend) and always requires explicit confirmation."
          : "This tool is flagged as requiring your confirmation.",
    };
  }

  // auto_low_risk / auto_approved reaching here means risk === 'write'.
  return {
    allowed: true,
    requiresApproval: false,
    code: "ok",
    reason: `Reversible action permitted under the "${mode}" permission mode.`,
  };
}

/** Validate a permission mode coming from the client — never trust the incoming string. */
export function parsePermissionMode(value: unknown): PermissionMode {
  const allowed: PermissionMode[] = ["read_only", "auto_low_risk", "auto_approved", "ask_everything"];
  return allowed.includes(value as PermissionMode) ? (value as PermissionMode) : "auto_low_risk";
}
