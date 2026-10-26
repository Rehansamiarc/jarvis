import { beforeEach, describe, expect, it } from "vitest";
import { fingerprint, randomToken, safeEqual, seal, unseal } from "@/lib/crypto/secrets";
import { resetEnvCache } from "@/lib/env";

const KEY = "a".repeat(64); // hex-encoded 32-byte key

beforeEach(() => {
  process.env.SECRET_ENCRYPTION_KEY = KEY;
  resetEnvCache();
});

describe("credential sealing", () => {
  it("round-trips a value without leaking the plaintext", () => {
    const secret = "wordpress app password: abcd 1234 efgh";
    const envelope = seal(secret);

    expect(envelope).not.toContain("abcd");
    expect(envelope.startsWith("v1.")).toBe(true);
    expect(unseal(envelope)).toBe(secret);
  });

  it("produces a different envelope each time (fresh IV)", () => {
    expect(seal("same")).not.toBe(seal("same"));
  });

  it("rejects a tampered ciphertext instead of returning garbage", () => {
    const envelope = seal("refresh-token-123");
    const parts = envelope.split(".");
    const data = Buffer.from(parts[3], "base64");
    data[0] ^= 0xff;
    parts[3] = data.toString("base64");

    expect(() => unseal(parts.join("."))).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const envelope = seal("refresh-token-123");
    const parts = envelope.split(".");
    parts[2] = Buffer.alloc(16, 7).toString("base64");
    expect(() => unseal(parts.join("."))).toThrow();
  });

  it("refuses an envelope from an unknown scheme version", () => {
    const [version, iv, tag, data] = seal("x").split(".");
    expect(() => unseal(["v9", iv, tag, data].join("."))).toThrow(/envelope format/i);
    expect(version).toBe("v1");
  });

  it("returns null for empty input rather than throwing", () => {
    expect(unseal(null)).toBeNull();
    expect(unseal(undefined)).toBeNull();
    expect(unseal("")).toBeNull();
  });

  it("memoises nothing: a rotated key cannot read old envelopes", () => {
    const envelope = seal("rotate-me");
    process.env.SECRET_ENCRYPTION_KEY = "b".repeat(64);
    resetEnvCache();
    expect(() => unseal(envelope)).toThrow();
  });
});

describe("fingerprint / safeEqual", () => {
  it("fingerprints deterministically without being reversible", () => {
    expect(fingerprint("hello")).toBe(fingerprint("hello"));
    expect(fingerprint("hello")).not.toBe(fingerprint("hellp"));
    expect(fingerprint("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("compares secrets of different length safely", () => {
    expect(safeEqual("token", "token")).toBe(true);
    expect(safeEqual("token", "token ")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });

  it("issues URL-safe random tokens of the requested size", () => {
    const token = randomToken(16);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(16);
    expect(randomToken(16)).not.toBe(token);
  });
});
