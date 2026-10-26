import { describe, expect, it } from "vitest";
import { evaluatePolicy, parsePermissionMode } from "@/lib/permissions/policy";

const connected = { wordpress: "connected", youtube: "connected" };

describe("permission policy", () => {
  it("always allows reads, even in read-only mode", () => {
    const decision = evaluatePolicy({
      mode: "read_only",
      risk: "read",
      connections: connected,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("blocks every mutation in read-only mode", () => {
    for (const risk of ["write", "high"] as const) {
      const decision = evaluatePolicy({ mode: "read_only", risk, connections: connected });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe("read_only");
      expect(decision.reason).toMatch(/Read-only/);
    }
  });

  it("requires confirmation for consequential actions in every non-read-only mode", () => {
    for (const mode of ["auto_low_risk", "auto_approved", "ask_everything"] as const) {
      const decision = evaluatePolicy({ mode, risk: "high", connections: connected });
      expect(decision.allowed).toBe(true);
      expect(decision.requiresApproval).toBe(true);
      expect(decision.code).toBe("needs_confirmation");
    }
  });

  it("lets reversible writes through without a prompt in auto modes", () => {
    for (const mode of ["auto_low_risk", "auto_approved"] as const) {
      const decision = evaluatePolicy({ mode, risk: "write", connections: connected });
      expect(decision.allowed).toBe(true);
      expect(decision.requiresApproval).toBe(false);
    }
  });

  it("confirms even reversible writes when the tool is individually flagged", () => {
    const decision = evaluatePolicy({
      mode: "auto_approved",
      risk: "write",
      toolRequiresApproval: true,
      connections: connected,
    });
    expect(decision.requiresApproval).toBe(true);
  });

  it("confirms everything in ask_everything, including writes", () => {
    const decision = evaluatePolicy({ mode: "ask_everything", risk: "write", connections: connected });
    expect(decision.requiresApproval).toBe(true);
  });

  it("refuses tools whose integration is not connected, before risk is considered", () => {
    const decision = evaluatePolicy({
      mode: "auto_approved",
      risk: "read",
      requiresConnection: "wordpress",
      connections: { wordpress: "error" },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("not_connected");
    expect(decision.reason).toMatch(/WordPress is not connected/);
  });

  it("accepts any one of several alternative providers", () => {
    const decision = evaluatePolicy({
      mode: "auto_low_risk",
      risk: "write",
      requiresAnyConnection: ["gmail", "resend"],
      connections: { resend: "connected" },
    });
    expect(decision.allowed).toBe(true);
  });

  it("names every alternative when none are connected", () => {
    const decision = evaluatePolicy({
      mode: "auto_low_risk",
      risk: "write",
      requiresAnyConnection: ["gmail", "resend"],
      connections: {},
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/Gmail or Email \(Resend\) are not connected/);
  });

  it("defaults unknown permission modes to the safe middle setting", () => {
    expect(parsePermissionMode("read_only")).toBe("read_only");
    expect(parsePermissionMode("auto_approved")).toBe("auto_approved");
    expect(parsePermissionMode("yolo")).toBe("auto_low_risk");
    expect(parsePermissionMode(undefined)).toBe("auto_low_risk");
    expect(parsePermissionMode({ mode: "auto_approved" })).toBe("auto_low_risk");
  });
});
